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
Bring up one vehicle's companion computer for a deployed fleet (no simulation).

    ros2 launch aeropact_bringup vehicle.launch.py site:=/etc/aeropact/site.yaml vehicle:=A01

Starts, in one component container (the vehicle's single point of fate):
  vehicle_interface   PX4 link over uXRCE-DDS (offboard control, arming arbitration, odometry)
  safety_supervisor   independent geofence / battery / separation / watchdog layer
  flight_manager      FlyRoute action server (waypoint tracking, take-off, landing)
  coordinator         fleet protocol (replica, gossip, ownership, auction, missions)
  mesh_radio_bridge   authenticated RadioFrame transport on the mesh network
plus the Micro XRCE-DDS Agent for the flight-controller link, a lifecycle manager and, optionally,
a black-box MCAP recording. The same file runs against PX4 SITL (use_sim_time:=true) for the
distributed rehearsal before any hardware flight.
"""

import importlib.util
import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, LogInfo, OpaqueFunction
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode

ARGS = {
    'site': ('', 'site configuration file (see config/site_example.yaml)'),
    'vehicle': ('', 'vehicle id from the site roster'),
    'world_file': ('', 'override site.world_file (e.g. a generated map in a rehearsal)'),
    'use_sim_time': ('false', 'true only against a simulator (SITL rehearsal)'),
    'agent': ('MicroXRCEAgent', 'Micro XRCE-DDS Agent executable'),
    'start_agent': ('true', 'start the XRCE agent for the flight-controller link'),
    'record': ('false', 'record a black-box MCAP bag of events and vehicle topics'),
    'log_dir': ('', 'black-box directory (default ~/.aeropact/blackbox)'),
    'log_level': ('info', 'ROS log level'),
}


def _site_module():
    path = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'site_config.py')
    spec = importlib.util.spec_from_file_location('aeropact_site_config', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _truthy(value):
    return str(value).lower() in ('1', 'true', 'yes', 'on')


def _setup(context):
    a = {k: LaunchConfiguration(k).perform(context) for k in ARGS}
    sc = _site_module()
    cfg = sc.load_site(a['site'], a['world_file'])
    vid = a['vehicle']
    site = cfg['site']
    if vid not in site['fleet_roster']:
        raise sc.SiteConfigError('vehicle %r is not in the site roster %s'
                                 % (vid, site['fleet_roster']))
    v = cfg['vehicles'][vid]
    pad = cfg['pads'][v['home_pad']]
    origin = cfg['world']['geodetic_origin']
    policy = cfg['policy']
    fleet = cfg['fleet']
    sim_time = _truthy(a['use_sim_time'])
    common = {'use_sim_time': sim_time}
    ns = '/' + vid
    ros_args = ['--ros-args', '--log-level', a['log_level']]
    safety_policy = site.get('safety_policy') or os.path.join(
        get_package_share_directory('aeropact_safety'), 'config', 'safety_policy.yaml')

    nodes = [
        ComposableNode(package='aeropact_px4', plugin='aeropact::px4::Px4VehicleInterfaceNode',
                       name='vehicle_interface', namespace=ns, parameters=[dict(common, **{
                           'drone_id': vid,
                           'geodetic_origin': [float(origin['lat_deg']),
                                               float(origin['lon_deg']),
                                               float(origin['alt_m'])],
                           # On hardware the autopilot's battery monitor is the pack's truth.
                           'publish_battery': True,
                           'termination_topic': '',
                           'payload_mechanism': str(v.get('payload', 'gripper'))})]),
        ComposableNode(package='aeropact_safety', plugin='aeropact::safety::SafetySupervisorNode',
                       name='safety_supervisor', namespace=ns, parameters=[dict(common, **{
                           'drone_id': vid, 'world_file': site['world_file'],
                           'policy_file': safety_policy,
                           'home': [float(pad[0]), float(pad[1]), float(pad[2])]})]),
        ComposableNode(package='aeropact_agent', plugin='aeropact::agent::FlightManagerNode',
                       name='flight_manager', namespace=ns, parameters=[common]),
        ComposableNode(package='aeropact_agent', plugin='aeropact::agent::CoordinatorNode',
                       name='coordinator', namespace=ns, parameters=[dict(common, **{
                           'drone_id': vid, 'world_file': site['world_file'],
                           'fleet_roster': list(site['fleet_roster']),
                           'depot_ids': list(site['depot_ids']), 'home_pad': v['home_pad'],
                           'allocation_mode': policy['allocation'],
                           'partition_policy': policy['partition'],
                           'bundle_len': int(policy['bundle_len']),
                           'auction_period_s': float(policy['auction_period_s']),
                           'gossip_period_s': float(policy['gossip_period_s']),
                           'lease_ttl_s': float(policy['lease_ttl_s']),
                           'renew_period_s': float(policy['renew_period_s']),
                           't_commit_s': float(policy['t_commit_s']),
                           'max_optimistic_claims': int(policy['max_optimistic_claims']),
                           'use_shard_leases': bool(policy['use_shard_leases']),
                           'use_charging_penalty': bool(policy['use_charging_penalty']),
                           'use_indirect_probing': bool(policy['use_indirect_probing']),
                           'capacity_kg': float(fleet['capacity_kg']),
                           'cruise_speed_mps': float(fleet['cruise_speed_mps']),
                           'battery_wh': float(fleet['battery_wh'])})]),
        ComposableNode(package='aeropact_radio', plugin='aeropact::radio::MeshRadioBridgeNode',
                       name='mesh_radio_bridge', namespace=ns,
                       parameters=[dict(common, **sc.mesh_parameters(cfg, vid))]),
    ]
    managed = [ns + '/' + n for n in ('vehicle_interface', 'safety_supervisor', 'flight_manager',
                                      'coordinator', 'mesh_radio_bridge')]
    actions = [LogInfo(msg='AeroPACT vehicle %s at site %s (home pad %s, sim_time=%s)'
                       % (vid, site.get('name', '?'), v['home_pad'], sim_time))]
    if _truthy(a['start_agent']):
        ap = v.get('autopilot') or {}
        if ap.get('transport', 'serial') == 'serial':
            agent_cmd = [a['agent'], 'serial', '--dev', str(ap.get('device', '/dev/ttyTHS1')),
                         '-b', str(ap.get('baudrate', 921600))]
        else:
            agent_cmd = [a['agent'], 'udp4', '-p', str(ap.get('port', 8888))]
        actions.append(ExecuteProcess(cmd=agent_cmd, name='xrce_agent', output='log',
                                      respawn=True, respawn_delay=2.0))
    actions.append(ComposableNodeContainer(
        name='computer', namespace=ns, package='rclcpp_components',
        executable='component_container', composable_node_descriptions=nodes, output='log',
        arguments=ros_args))
    actions.append(Node(package='aeropact_agent', executable='lifecycle_manager',
                        name='lifecycle_manager', namespace=ns, output='log', arguments=ros_args,
                        parameters=[{'node_names': managed, 'autostart': True,
                                     'use_sim_time': sim_time}]))
    if _truthy(a['record']):
        log_dir = a['log_dir'] or os.path.join(os.path.expanduser('~'), '.aeropact', 'blackbox')
        topics = ['/fleet/events', '/diagnostics', ns + '/odom', ns + '/status',
                  ns + '/safety/status', ns + '/autopilot/status', ns + '/battery']
        actions.append(ExecuteProcess(
            cmd=['ros2', 'bag', 'record', '-s', 'mcap', '--max-bag-duration', '600', '-o',
                 os.path.join(log_dir, vid)] + topics, name='blackbox', output='log'))
    return actions


def generate_launch_description():
    return LaunchDescription(
        [DeclareLaunchArgument(k, default_value=v[0], description=v[1]) for k, v in ARGS.items()]
        + [OpaqueFunction(function=_setup)])
