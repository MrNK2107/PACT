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
Bring up one complete AeroPACT run from a scenario file.

    ros2 launch aeropact_bringup scenario.launch.py scenario:=s1_hub_loss \
        system:=pact_quorum backend:=gazebo gui:=false rviz:=true seed:=1

Process layout (memory-conscious, one process per physical computer):
  physics      gz sim server + one ros_gz_bridge, or the kinematic world
  autopilots   (px4 backend) one PX4 SITL process per vehicle + one Micro XRCE-DDS Agent
  sim          one container: radio medium, vehicle plant, proximity sensing, workload, faults
  depots       one container for all depot nodes
  /<drone>     one container per vehicle: coordinator, flight manager, safety supervisor
  /hub         central planner (central system only)
  lifecycle    one manager that configures and activates every lifecycle node in order
  recorder     event log writer; its exit at `duration` ends the run
"""

import importlib.util
import os

from ament_index_python.packages import get_package_prefix, get_package_share_directory
from launch import LaunchDescription
from launch.actions import (DeclareLaunchArgument, EmitEvent, ExecuteProcess, LogInfo,
                            OpaqueFunction, RegisterEventHandler, SetEnvironmentVariable)
from launch.event_handlers import OnProcessExit
from launch.events import Shutdown
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import ComposableNodeContainer, Node
from launch_ros.descriptions import ComposableNode
import yaml

ARGS = {
    'scenario': ('s0_healthy', 'scenario name (in share/aeropact_bringup/scenarios) or path'),
    'system': ('', 'system preset from config/systems.yaml (empty: scenario policy)'),
    'seed': ('', 'override the scenario seed'),
    'backend': ('gazebo', 'physics backend: gazebo | kinematic | px4 (PX4 SITL autopilots)'),
    'time_scale': ('1.0', 'kinematic backend speed-up over real time'),
    'gui': ('false', 'start the Gazebo GUI client'),
    'rviz': ('false', 'start RViz with the fleet monitor'),
    'run_dir': ('', 'output directory (default ~/.aeropact/runs/<scenario>__<system>__s<seed>)'),
    'duration': ('', 'override the scenario duration (s of simulation time)'),
    'drones': ('', 'override the fleet size'),
    'drone_isolation': ('process', 'process: one container per drone | shared: one for all'),
    'record_bag': ('false', 'also record an MCAP bag of key topics'),
    'radio': ('sim', 'inter-agent transport: sim (simulated radio medium) | mesh (authenticated '
              'UDP bridges, the deployed transport; radio faults unavailable)'),
    'fleet_key': ('', 'fleet key file for radio:=mesh (default: the repository TEST key)'),
    'log_level': ('info', 'ROS log level'),
}


def _load_generator():
    path = os.path.join(get_package_prefix('aeropact_sim'), 'lib', 'aeropact_sim',
                        'generate_world.py')
    spec = importlib.util.spec_from_file_location('aeropact_generate_world', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _resolve_scenario(name):
    if os.path.isfile(name):
        return os.path.abspath(name)
    path = os.path.join(get_package_share_directory('aeropact_bringup'), 'scenarios',
                        name + '.yaml')
    if not os.path.isfile(path):
        raise RuntimeError('unknown scenario: %s' % name)
    return path


def _truthy(value):
    return str(value).lower() in ('1', 'true', 'yes', 'on')


def _px4_toolchain():
    """Locate the pinned PX4 SITL toolchain (tools/px4/build_px4.sh) and the vehicle interface."""
    root = os.environ.get('AEROPACT_PX4_ROOT',
                          os.path.join(os.path.expanduser('~'), '.cache', 'aeropact', 'px4'))
    px4 = os.path.join(root, 'PX4-Autopilot', 'build', 'px4_sitl_default', 'bin', 'px4')
    agent = os.path.join(root, 'agent', 'bin', 'MicroXRCEAgent')
    component = os.path.join(get_package_prefix('aeropact_px4'), 'lib',
                             'libpx4_vehicle_interface_component.so')
    missing = [p for p in (px4, agent, component) if not os.path.exists(p)]
    if missing:
        raise RuntimeError('backend px4 needs the PX4 SITL toolchain and the vehicle interface; '
                           'missing: %s (see docs/PX4_SITL.md)' % ', '.join(missing))
    return {'root': root, 'agent': agent,
            'models': os.path.join(root, 'PX4-Autopilot', 'Tools', 'simulation', 'gz', 'models'),
            'agent_lib': os.path.join(root, 'agent', 'lib')}


def _setup(context):
    cfg = {k: LaunchConfiguration(k).perform(context) for k in ARGS}
    bringup = get_package_share_directory('aeropact_bringup')
    scenario_path = _resolve_scenario(cfg['scenario'])
    with open(scenario_path, encoding='utf-8') as f:
        raw = yaml.safe_load(f)
    system = cfg['system']
    seed = int(cfg['seed']) if cfg['seed'] else int(raw.get('seed', 42))
    run_dir = cfg['run_dir'] or os.path.join(
        os.path.expanduser('~'), '.aeropact', 'runs',
        '%s__%s__s%d' % (raw.get('name', cfg['scenario']), system or 'scenario', seed))
    world_dir = os.path.join(run_dir, 'world')

    gen = _load_generator()
    info = gen.generate(scenario_path, os.path.join(get_package_share_directory('aeropact_sim'),
                                                    'maps'),
                        world_dir, backend=cfg['backend'], seed=seed,
                        n_drones=int(cfg['drones']) if cfg['drones'] else None)
    scenario = info['scenario']
    if system:
        with open(os.path.join(bringup, 'config', 'systems.yaml'), encoding='utf-8') as f:
            presets = yaml.safe_load(f)
        if system not in presets:
            raise RuntimeError('unknown system preset: %s' % system)
        scenario['policy'] = gen.deep_merge(scenario['policy'], presets[system])
    with open(os.path.join(world_dir, 'scenario.yaml'), 'w', encoding='utf-8') as f:
        yaml.safe_dump(scenario, f, sort_keys=False)
    duration = float(cfg['duration']) if cfg['duration'] else float(scenario['duration_s'])

    fleet = info['fleet']
    drone_ids = [d['id'] for d in fleet['drones']]
    depot_ids = fleet['depots']
    world_file = os.path.join(world_dir, 'world.yaml')
    scenario_file = os.path.join(world_dir, 'scenario.yaml')
    policy = scenario['policy']
    fleet_cfg = scenario['fleet']
    net = scenario['network']
    work = scenario['workload']
    sim_cfg = scenario.get('sim', {})
    central = policy['allocation'] == 'central'
    with open(world_file, encoding='utf-8') as f:
        world_doc = yaml.safe_load(f)['world']
    pads = {p['id']: p['position'] for d in world_doc['depots'] for p in d['pads']}
    origin = world_doc['geodetic_origin']
    px4 = cfg['backend'] == 'px4'
    common = {'use_sim_time': True}
    summary = 'AeroPACT run: scenario=%s system=%s seed=%d drones=%d backend=%s ' \
        'duration=%.0fs -> %s' % (scenario['name'], system or policy['allocation'], seed,
                                  len(drone_ids), cfg['backend'], duration, run_dir)
    actions = [LogInfo(msg=summary)]
    ros_args = ['--ros-args', '--log-level', cfg['log_level']]

    # ---- physics -------------------------------------------------------------------------
    # Simulation time is held until every lifecycle node is active: the kinematic world waits for
    # /system/ready, Gazebo starts paused and is un-paused by the lifecycle manager.
    on_ready = ''
    gz_world = info['map'].get('name', 'map')
    if cfg['backend'] in ('gazebo', 'px4'):
        on_ready = ('gz service -s /world/%s/control --reqtype gz.msgs.WorldControl '
                    '--reptype gz.msgs.Boolean --timeout 5000 --req "pause: false"' % gz_world)
    if cfg['backend'] in ('gazebo', 'px4'):
        resource_path = [os.path.join(get_package_share_directory('aeropact_sim'), 'models')]
        if px4:
            toolchain = _px4_toolchain()
            resource_path.append(toolchain['models'])
        actions.append(SetEnvironmentVariable('GZ_SIM_RESOURCE_PATH', ':'.join(resource_path)))
        actions.append(ExecuteProcess(
            cmd=['gz', 'sim', '-s', '-v', '2', os.path.join(world_dir, 'world.sdf')],
            name='gz_server', output='log'))
        if _truthy(cfg['gui']):
            actions.append(ExecuteProcess(cmd=['gz', 'sim', '-g', '-v', '2'], name='gz_gui',
                                          output='log'))
        actions.append(Node(package='ros_gz_bridge', executable='parameter_bridge',
                            name='gz_bridge', output='log',
                            parameters=[{'config_file': os.path.join(world_dir, 'bridge.yaml'),
                                         'use_sim_time': True}]))
        if px4:
            # One agent bridges every autopilot's uXRCE-DDS client into ROS 2 (UDP 8888).
            agent_env = {'LD_LIBRARY_PATH': toolchain['agent_lib'] + ':' +
                         os.environ.get('LD_LIBRARY_PATH', '')}
            actions.append(ExecuteProcess(cmd=[toolchain['agent'], 'udp4', '-p', '8888'],
                                          name='xrce_agent', output='log',
                                          additional_env=agent_env))
            launcher = os.path.join(get_package_prefix('aeropact_px4'), 'lib', 'aeropact_px4',
                                    'px4_sitl_instance.sh')
            params = os.path.join(get_package_share_directory('aeropact_px4'), 'config',
                                  'px4_sitl.params')
            for k, d in enumerate(fleet['drones']):
                actions.append(ExecuteProcess(
                    cmd=['bash', launcher, str(k), d['id'], gz_world,
                         os.path.join(run_dir, 'px4', d['id']), params],
                    name='px4_%s' % d['id'], output='log',
                    additional_env={'AEROPACT_PX4_ROOT': toolchain['root']}))
    else:
        spawn = [float(v) for d in fleet['drones'] for v in d['spawn']]
        actions.append(Node(package='aeropact_sim', executable='kinematic_world',
                            name='kinematic_world', output='log', arguments=ros_args,
                            parameters=[{'drone_ids': drone_ids, 'spawn': spawn,
                                         'time_scale': float(cfg['time_scale'])}]))

    # ---- simulated environment -------------------------------------------------------------
    latency = net.get('latency_ms', [50, 250])
    # The simulated environment works from ground truth; with PX4 the vehicles' odometry is the
    # autopilot's estimate, so truth comes from Gazebo directly.
    truth_odom = 'ground_truth/odom' if px4 else 'odom'
    soc0 = fleet_cfg.get('initial_soc', 0.95)
    soc0 = [float(v) for v in soc0] if isinstance(soc0, list) else [float(soc0)]
    mesh = cfg['radio'] == 'mesh'
    if cfg['radio'] not in ('sim', 'mesh'):
        raise RuntimeError('radio must be sim or mesh')
    fleet_key = cfg['fleet_key'] or os.path.join(
        get_package_share_directory('aeropact_radio'), 'config', 'test_fleet.key')
    mesh_port = 47000 + int(os.environ.get('ROS_DOMAIN_ID', '0'))

    def mesh_bridge(node_id, namespace):
        # Each computer's own bridge onto the shared multicast group (loopback on one host).
        return ComposableNode(
            package='aeropact_radio', plugin='aeropact::radio::MeshRadioBridgeNode',
            name='mesh_radio_bridge', namespace=namespace, parameters=[dict(common, **{
                'node_id': node_id, 'key_file': fleet_key, 'mode': 'multicast',
                'port': mesh_port, 'interface_address': '127.0.0.1',
                'multicast_loopback': True})])

    sim_nodes = [] if mesh else [
        ComposableNode(package='aeropact_sim', plugin='aeropact::sim::RadioMediumNode',
                       name='radio_medium', parameters=[dict(common, **{
                           'drone_ids': drone_ids, 'depot_ids': depot_ids,
                           'world_file': world_file, 'range_m': float(net['range_m']),
                           'base_loss': float(net['loss']),
                           'latency_min_s': latency[0] / 1000.0,
                           'latency_max_s': latency[1] / 1000.0, 'seed': seed})])]
    sim_nodes += [
        ComposableNode(package='aeropact_sim', plugin='aeropact::sim::VehiclePlantNode',
                       name='vehicle_plant', parameters=[dict(common, **{
                           'drone_ids': drone_ids, 'world_file': world_file,
                           'initial_soc': soc0, 'battery_wh': float(fleet_cfg['battery_wh']),
                           'charge_time_s': float(sim_cfg.get('charge_time_s', 240.0)),
                           'odom_topic': truth_odom,
                           'motor_cut_topic': 'sim/motor_cut' if px4 else ''})]),
        ComposableNode(package='aeropact_sim', plugin='aeropact::sim::ProximitySensorNode',
                       name='proximity_sensor', parameters=[dict(common, **{
                           'drone_ids': drone_ids, 'seed': seed + 1,
                           'odom_topic': truth_odom})]),
        ComposableNode(package='aeropact_sim', plugin='aeropact::sim::WorkloadGeneratorNode',
                       name='workload_generator', parameters=[dict(common, **{
                           'world_file': world_file, 'scenario_file': scenario_file,
                           'seed': seed + 2,
                           'arrival_rate_per_min': float(work['arrival_rate_per_min']),
                           'priority_mix': [float(v) for v in work['priority_mix']],
                           'deadline_s': [float(v) for v in work['deadline_s']],
                           'weight_kg': [float(v) for v in work['weight_kg']],
                           'start_s': float(work.get('start_s', 20.0)),
                           'stop_s': float(work.get('stop_s', duration))})]),
        ComposableNode(package='aeropact_sim', plugin='aeropact::sim::FaultInjectorNode',
                       name='fault_injector', parameters=[dict(common, **{
                           'scenario_file': scenario_file, 'world_file': world_file,
                           'drone_ids': drone_ids})]),
    ]
    actions.append(ComposableNodeContainer(
        name='sim_container', namespace='/sim', package='rclcpp_components',
        executable='component_container', composable_node_descriptions=sim_nodes,
        output='log', arguments=ros_args))

    # ---- depots ----------------------------------------------------------------------------
    depot_nodes = [ComposableNode(
        package='aeropact_depot', plugin='aeropact::depot::DepotNode', name='depot',
        namespace='/depots/%s' % d, parameters=[dict(common, **{
            'depot_id': d, 'world_file': world_file, 'fleet_roster': drone_ids,
            'initial_assignments': fleet['initial_assignments'],
            'arbitration': bool(policy.get('depot_arbitration', True)),
            'forward_to_hub': central,
            # Pad occupancy sensors (simulated by the plant) with real autopilots (D-31).
            'pad_sensor_topic': '/sim/pad_occupancy' if px4 else ''})]) for d in depot_ids]
    if mesh:
        depot_nodes += [mesh_bridge(d, '/depots/%s' % d) for d in depot_ids]
    actions.append(ComposableNodeContainer(
        name='depot_container', namespace='/depots', package='rclcpp_components',
        executable='component_container', composable_node_descriptions=depot_nodes,
        output='log', arguments=ros_args))
    managed = ['/depots/%s/depot' % d for d in depot_ids]
    if mesh:
        managed += ['/depots/%s/mesh_radio_bridge' % d for d in depot_ids]

    # ---- central hub (baseline) -------------------------------------------------------------
    if central:
        actions.append(ComposableNodeContainer(
            name='hub_container', namespace='/hub', package='rclcpp_components',
            executable='component_container', output='log', arguments=ros_args,
            composable_node_descriptions=[ComposableNode(
                package='aeropact_baselines', plugin='aeropact::baselines::CentralPlannerNode',
                name='central_planner', namespace='/hub', parameters=[dict(common, **{
                    'world_file': world_file,
                    'battery_wh': float(fleet_cfg['battery_wh'])})])]))
        managed.append('/hub/central_planner')

    # ---- fleet -------------------------------------------------------------------------------
    safety_policy = os.path.join(get_package_share_directory('aeropact_safety'), 'config',
                                 'safety_policy.yaml')
    shared = cfg['drone_isolation'] == 'shared'
    shared_nodes = []
    for d in fleet['drones']:
        did = d['id']
        ns = '/' + did
        coordinator = {
            'drone_id': did, 'world_file': world_file, 'fleet_roster': drone_ids,
            'depot_ids': depot_ids, 'home_pad': d['pad'],
            'allocation_mode': policy['allocation'], 'partition_policy': policy['partition'],
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
            'capacity_kg': float(fleet_cfg['capacity_kg']),
            'cruise_speed_mps': float(fleet_cfg['cruise_speed_mps']),
            'battery_wh': float(fleet_cfg['battery_wh']),
            'seed': seed,
        }
        pad = pads[d['pad']]
        nodes = []
        if px4:
            # The companion computer's link to its autopilot: same component on real hardware.
            nodes.append(ComposableNode(
                package='aeropact_px4', plugin='aeropact::px4::Px4VehicleInterfaceNode',
                name='vehicle_interface', namespace=ns, parameters=[dict(common, **{
                    'drone_id': did,
                    'geodetic_origin': [float(origin['lat_deg']), float(origin['lon_deg']),
                                        float(origin['alt_m'])]})]))
            managed.append(ns + '/vehicle_interface')
        nodes += [
            ComposableNode(package='aeropact_safety',
                           plugin='aeropact::safety::SafetySupervisorNode',
                           name='safety_supervisor', namespace=ns, parameters=[dict(common, **{
                               'drone_id': did, 'world_file': world_file,
                               'policy_file': safety_policy,
                               'home': [float(pad[0]), float(pad[1]), float(pad[2])]})]),
            ComposableNode(package='aeropact_agent', plugin='aeropact::agent::FlightManagerNode',
                           name='flight_manager', namespace=ns, parameters=[common]),
            ComposableNode(package='aeropact_agent', plugin='aeropact::agent::CoordinatorNode',
                           name='coordinator', namespace=ns,
                           parameters=[dict(common, **coordinator)]),
        ]
        managed += [ns + '/safety_supervisor', ns + '/flight_manager', ns + '/coordinator']
        if mesh:
            nodes.append(mesh_bridge(did, ns))
            managed.append(ns + '/mesh_radio_bridge')
        if shared:
            shared_nodes += nodes
        else:
            actions.append(ComposableNodeContainer(
                name='computer', namespace=ns, package='rclcpp_components',
                executable='component_container', composable_node_descriptions=nodes,
                output='log', arguments=ros_args))
    if shared:
        actions.append(ComposableNodeContainer(
            name='fleet_container', namespace='/fleet', package='rclcpp_components',
            executable='component_container', composable_node_descriptions=shared_nodes,
            output='log', arguments=ros_args))

    actions.append(Node(package='aeropact_agent', executable='lifecycle_manager',
                        name='lifecycle_manager', output='log', arguments=ros_args,
                        parameters=[{'node_names': managed, 'autostart': True,
                                     'use_sim_time': True,
                                     'on_ready_command': on_ready}]))

    # ---- observation ----------------------------------------------------------------------------
    recorder = Node(package='aeropact_eval', executable='event_recorder', name='event_recorder',
                    output='screen', parameters=[{'run_dir': run_dir, 'duration_s': duration,
                                                  'drone_ids': drone_ids,
                                                  'use_sim_time': True}])
    actions.append(recorder)
    actions.append(RegisterEventHandler(OnProcessExit(
        target_action=recorder, on_exit=[EmitEvent(event=Shutdown(reason='run complete'))])))
    if _truthy(cfg['rviz']):
        actions.append(Node(package='aeropact_eval', executable='fleet_monitor',
                            name='fleet_monitor', output='log',
                            parameters=[{'world_file': world_file, 'drone_ids': drone_ids,
                                         'use_sim_time': True}]))
        actions.append(Node(package='rviz2', executable='rviz2', name='rviz', output='log',
                            arguments=['-d', os.path.join(bringup, 'rviz', 'aeropact.rviz')],
                            parameters=[{'use_sim_time': True}]))
    if _truthy(cfg['record_bag']):
        topics = ['/fleet/events', '/airspace/restrictions', '/diagnostics']
        for did in drone_ids:
            topics += ['/%s/odom' % did, '/%s/status' % did, '/%s/safety/status' % did]
        actions.append(ExecuteProcess(
            cmd=['ros2', 'bag', 'record', '-s', 'mcap', '-o', os.path.join(run_dir, 'bag'),
                 '--use-sim-time'] + topics, name='bag_recorder', output='log'))
    return actions


def generate_launch_description():
    return LaunchDescription(
        [DeclareLaunchArgument(k, default_value=v[0], description=v[1]) for k, v in ARGS.items()]
        + [OpaqueFunction(function=_setup)])
