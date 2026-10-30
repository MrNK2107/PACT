# Copyright 2026 AeroPACT Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Bring up one depot computer for a deployed fleet.

    ros2 launch aeropact_bringup depot.launch.py site:=/etc/aeropact/site.yaml depot:=D1

Starts the depot node (order intake via SubmitOrder, parcel and pad arbitration with fencing
tokens, bay management, re-orders) and the depot's mesh radio bridge, under a lifecycle manager.
Order management systems submit work with the `/depots/<id>/submit_order` service.
"""

import importlib.util
import os

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, LogInfo, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode

ARGS = {
    'site': ('', 'site configuration file (see config/site_example.yaml)'),
    'depot': ('', 'depot id from the site'),
    'world_file': ('', 'override site.world_file'),
    'use_sim_time': ('false', 'true only against a simulator (SITL rehearsal)'),
    'log_level': ('info', 'ROS log level'),
}


def _site_module():
    path = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'site_config.py')
    spec = importlib.util.spec_from_file_location('aeropact_site_config', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _setup(context):
    a = {k: LaunchConfiguration(k).perform(context) for k in ARGS}
    sc = _site_module()
    cfg = sc.load_site(a['site'], a['world_file'])
    did = a['depot']
    site = cfg['site']
    if did not in site['depot_ids']:
        raise sc.SiteConfigError('depot %r is not in the site depots %s'
                                 % (did, site['depot_ids']))
    sim_time = str(a['use_sim_time']).lower() in ('1', 'true', 'yes', 'on')
    common = {'use_sim_time': sim_time}
    ns = '/depots/' + did
    depot_cfg = cfg['depots'].get(did) or {}
    # Vehicles parked on this depot's pads at start (pad holders are tracked from then on).
    assignments = ['%s:%s' % (vid, cfg['vehicles'][vid]['home_pad'])
                   for vid in site['fleet_roster']
                   if cfg['vehicles'][vid]['home_pad'] in
                   {p['id'] for d in cfg['world']['depots'] if d['id'] == did for p in d['pads']}]
    nodes = [
        ComposableNode(package='aeropact_depot', plugin='aeropact::depot::DepotNode', name='depot',
                       namespace=ns, parameters=[dict(common, **{
                           'depot_id': did, 'world_file': site['world_file'],
                           'fleet_roster': list(site['fleet_roster']),
                           'initial_assignments': assignments or [''],
                           'arbitration': True, 'position_source': 'radio',
                           'pad_sensor_topic': str(depot_cfg.get('pad_sensor_topic', '')),
                           'gossip_period_s': float(cfg['policy']['gossip_period_s'])})]),
        ComposableNode(package='aeropact_radio', plugin='aeropact::radio::MeshRadioBridgeNode',
                       name='mesh_radio_bridge', namespace=ns,
                       parameters=[dict(common, **sc.mesh_parameters(cfg, did))]),
    ]
    ros_args = ['--ros-args', '--log-level', a['log_level']]
    return [
        LogInfo(msg='AeroPACT depot %s at site %s' % (did, site.get('name', '?'))),
        ComposableNodeContainer(name='depot_computer', namespace=ns, package='rclcpp_components',
                                executable='component_container',
                                composable_node_descriptions=nodes, output='log',
                                arguments=ros_args),
        Node(package='aeropact_agent', executable='lifecycle_manager', name='lifecycle_manager',
             namespace=ns, output='log', arguments=ros_args,
             parameters=[{'node_names': [ns + '/depot', ns + '/mesh_radio_bridge'],
                          'autostart': True, 'use_sim_time': sim_time}]),
    ]


def generate_launch_description():
    return LaunchDescription(
        [DeclareLaunchArgument(k, default_value=v[0], description=v[1]) for k, v in ARGS.items()]
        + [OpaqueFunction(function=_setup)])
