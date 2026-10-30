#!/usr/bin/env bash
# Distributed SITL rehearsal: the deployment launch files (vehicle.launch.py, depot.launch.py),
# unchanged, against PX4 SITL. Every vehicle and depot is a separate "computer" (own launch, own
# lifecycle manager, own XRCE agent for each vehicle) and they talk only through the
# authenticated mesh radio bridges (UDP multicast on loopback). No simulated radio, no plant, no
# workload generator: orders arrive through the public SubmitOrder service.
#
# Usage: distributed_sitl.sh [duration_s] [n_orders]
set -uo pipefail
DURATION=${1:-600}
ORDERS=${2:-4}
WS=$(cd "$(dirname "$0")/../.." && pwd)
PX4_ROOT=${AEROPACT_PX4_ROOT:-$HOME/.cache/aeropact/px4}
OUT=${REHEARSAL_DIR:-$HOME/.aeropact/rehearsal}
rm -rf "$OUT"; mkdir -p "$OUT"
set +u
source /opt/ros/jazzy/setup.bash
source "$PX4_ROOT/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
set -u
export ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-93}
SHARE=$(ros2 pkg prefix aeropact_bringup)/share/aeropact_bringup

# 1. The "site": a generated test_field map with a surveyed-style origin, the example site file
#    pointed at it, loopback multicast, and site keys provisioned the way a site does it:
#    AUTH=ed25519 (default) gives every computer its own key (fleet_keygen --ed25519) and builds
#    the public-key roster; AUTH=hmac uses the repository TEST fleet key.
AUTH=${AUTH:-ed25519}
KEYGEN="$(ros2 pkg prefix aeropact_radio)/lib/aeropact_radio/fleet_keygen"
mkdir -p "$OUT/keys"
: > "$OUT/keys/roster"
for node in A01 A02 D1 D2; do
  "$KEYGEN" --ed25519 "$node" "$OUT/keys/$node.key" >> "$OUT/keys/roster"
done
python3 "$WS/src/aeropact_sim/scripts/generate_world.py" --backend px4 --drones 2 \
  --scenario "$WS/src/aeropact_bringup/scenarios/px4_s0_healthy.yaml" \
  --maps-dir "$WS/src/aeropact_sim/maps" --out "$OUT/world" > /dev/null
python3 - "$SHARE/config/site_example.yaml" "$OUT" \
  "$(ros2 pkg prefix aeropact_radio)/share/aeropact_radio/config/test_fleet.key" "$AUTH" <<'EOF'
import sys, yaml
src, out, key, auth = sys.argv[1:5]
doc = yaml.safe_load(open(src))
doc['site']['world_file'] = out + '/world/world.yaml'
doc['site']['fleet_key'] = key
doc['mesh'].update({'interface_address': '127.0.0.1', 'multicast_loopback': True,
                    'port': 47100, 'auth': auth,
                    'public_keys_file': out + '/keys/roster'})
fleet = yaml.safe_load(open(out + '/world/fleet.yaml'))
for d in fleet['drones']:
    doc['vehicles'][d['id']]['home_pad'] = d['pad']
for node in ('A01', 'A02'):
    doc['vehicles'][node]['private_key_file'] = '%s/keys/%s.key' % (out, node)
for node in ('D1', 'D2'):
    doc['depots'][node] = dict(doc['depots'].get(node) or {},
                               private_key_file='%s/keys/%s.key' % (out, node))
yaml.safe_dump(doc, open(out + '/site.yaml', 'w'), sort_keys=False)
EOF
echo "mesh auth: $AUTH ($(wc -l < "$OUT/keys/roster") nodes in the roster)"
WORLD=$(python3 -c "import yaml;print(yaml.safe_load(open('$OUT/world/world.yaml'))['world']['name'])")
export GZ_SIM_RESOURCE_PATH="$WS/src/aeropact_sim/models:$PX4_ROOT/PX4-Autopilot/Tools/simulation/gz/models"
AGENT="$PX4_ROOT/agent/bin/MicroXRCEAgent"
export LD_LIBRARY_PATH="$PX4_ROOT/agent/lib:${LD_LIBRARY_PATH:-}"

PIDS=()
cleanup() {
  kill "${PIDS[@]}" 2>/dev/null
  sleep 3
  pkill -f "px4_sitl_default/bin/px4" 2>/dev/null
  pkill -f "$AGENT" 2>/dev/null
  pkill -f "gz sim -s -r" 2>/dev/null
  pkill -f "aeropact_bringup vehicle.launch.py" 2>/dev/null
  pkill -f "aeropact_bringup depot.launch.py" 2>/dev/null
}
trap cleanup EXIT

# 2. The physical world: Gazebo with the two airframes, and the simulation clock.
gz sim -s -r -v 1 "$OUT/world/world.sdf" > "$OUT/gz.log" 2>&1 & PIDS+=($!)
ros2 run ros_gz_bridge parameter_bridge /clock@rosgraph_msgs/msg/Clock[gz.msgs.Clock \
  > "$OUT/clock_bridge.log" 2>&1 & PIDS+=($!)

# 3. Each vehicle's flight controller: PX4 SITL with its own XRCE port (one agent per vehicle,
#    as on separate companion computers).
for i in 0 1; do
  id=$(printf 'A%02d' $((i + 1)))
  PX4_UXRCE_DDS_PORT=$((8888 + i)) AEROPACT_PX4_ROOT=$PX4_ROOT \
    bash "$WS/src/aeropact_px4/scripts/px4_sitl_instance.sh" "$i" "$id" "$WORLD" \
    "$OUT/px4/$id" "$WS/src/aeropact_px4/config/px4_sitl.params" > "$OUT/px4_$id.log" 2>&1 &
  PIDS+=($!)
done

# 4. The deployed software, one launch per computer.
for d in D1 D2; do
  ros2 launch aeropact_bringup depot.launch.py site:="$OUT/site.yaml" depot:=$d \
    use_sim_time:=true > "$OUT/depot_$d.log" 2>&1 & PIDS+=($!)
done
for id in A01 A02; do
  ros2 launch aeropact_bringup vehicle.launch.py site:="$OUT/site.yaml" vehicle:=$id \
    use_sim_time:=true agent:="$AGENT" record:=true log_dir:="$OUT/blackbox" \
    > "$OUT/vehicle_$id.log" 2>&1 & PIDS+=($!)
done
ros2 run aeropact_eval event_recorder --ros-args -p run_dir:="$OUT/run" \
  -p duration_s:="${DURATION}.0" -p "drone_ids:=[A01,A02]" -p use_sim_time:=true \
  > "$OUT/recorder.log" 2>&1 &
REC=$!

# 5. Operations: wait for the autopilots' estimators, then place orders.
sleep 45
python3 "$WS/tools/px4/rehearsal_orders.py" "$OUT/world/world.yaml" "$ORDERS" 15 \
  > "$OUT/orders.log" 2>&1
cat "$OUT/orders.log"
wait $REC
echo "=== recorder finished"
ros2 run aeropact_eval metrics "$OUT/run" 2>&1 | tail -25
python3 "$WS/tools/wsl/events.py" "$OUT/run" \
  TASK_CREATED,CLAIM,PICKED_UP,DELIVERED,AUTOPILOT_LINK,RADIO_AUTH_REJECT,SAFETY_ACTION \
  | head -60
