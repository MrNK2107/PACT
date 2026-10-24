#!/usr/bin/env bash
# Smoke test of the PX4 SITL toolchain outside the full stack: generate a px4 world, start
# Gazebo + the XRCE agent + N PX4 instances attached to the generated airframes, then report the
# ROS 2 topics each autopilot exposes and the PX4 boot log. Usage: smoke_px4.sh [n_vehicles] [secs]
set -uo pipefail
N=${1:-1}
SECS=${2:-45}
WS=$(cd "$(dirname "$0")/../.." && pwd)
PX4_ROOT=${AEROPACT_PX4_ROOT:-$HOME/.cache/aeropact/px4}
OUT=${SMOKE_DIR:-$HOME/.cache/aeropact/smoke}
rm -rf "$OUT"; mkdir -p "$OUT"
set +u; source /opt/ros/jazzy/setup.bash; source "$PX4_ROOT/ws/install/setup.bash"; set -u
export ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-91}

python3 "$WS/src/aeropact_sim/scripts/generate_world.py" --backend px4 --drones "$N" \
  --scenario "$WS/src/aeropact_bringup/scenarios/px4_s0_healthy.yaml" \
  --maps-dir "$WS/src/aeropact_sim/maps" --out "$OUT/world"
WORLD=$(python3 -c "import yaml;print(yaml.safe_load(open('$OUT/world/world.yaml'))['world']['name'])")
export GZ_SIM_RESOURCE_PATH="$WS/src/aeropact_sim/models:$PX4_ROOT/PX4-Autopilot/Tools/simulation/gz/models"

gz sim -s -r -v 2 "$OUT/world/world.sdf" > "$OUT/gz.log" 2>&1 &
GZ=$!
LD_LIBRARY_PATH="$PX4_ROOT/agent/lib:${LD_LIBRARY_PATH:-}" "$PX4_ROOT/agent/bin/MicroXRCEAgent" \
  udp4 -p 8888 > "$OUT/agent.log" 2>&1 &
AGENT=$!
PIDS=()
for ((i = 0; i < N; i++)); do
  id=$(printf 'A%02d' $((i + 1)))
  AEROPACT_PX4_ROOT=$PX4_ROOT bash "$WS/src/aeropact_px4/scripts/px4_sitl_instance.sh" "$i" "$id" \
    "$WORLD" "$OUT/px4/$id" "$WS/src/aeropact_px4/config/px4_sitl.params" \
    > "$OUT/px4_$id.log" 2>&1 &
  PIDS+=($!)
done
sleep "$SECS"
echo "=== ROS 2 topics"
ros2 topic list | grep -E "fmu" | sort | head -60
echo "=== gz topics (model odometry)"
gz topic -l | grep -E "odometry|clock" | head
for ((i = 0; i < N; i++)); do
  id=$(printf 'A%02d' $((i + 1)))
  echo "=== PX4 $id log (tail)"
  tail -25 "$OUT/px4_$id.log"
done
echo "=== PX4 parameters (instance 0)"
for p in SYS_AUTOSTART NAV_DLL_ACT COM_RC_IN_MODE COM_OBL_RC_ACT RTL_RETURN_ALT UXRCE_DDS_KEY \
  CBRK_FLIGHTTERM; do
  (cd "$OUT/px4/A01" && "$PX4_ROOT/PX4-Autopilot/build/px4_sitl_default/bin/px4-param" \
    --instance 0 show -q "$p" 2>/dev/null | tr '\n' ' '; echo " <- $p")
done
echo "=== preflight / arming messages"
grep -hE "Preflight|Arming|arming|WARN|ERROR" "$OUT"/px4_*.log | grep -v "data writer" | sort | uniq -c | head -20
echo "=== gz log (tail)"; tail -10 "$OUT/gz.log"
kill "${PIDS[@]}" "$AGENT" "$GZ" 2>/dev/null
sleep 2
pkill -f "px4_sitl_default/bin/px4" 2>/dev/null
pkill -f "gz sim -s -r -v 2 $OUT" 2>/dev/null
exit 0
