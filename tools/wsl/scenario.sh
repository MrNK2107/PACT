#!/usr/bin/env bash
# Runs one scenario through the full launch inside WSL and prints the metrics summary.
# Usage: scenario.sh <scenario> <system|-> <backend> [extra launch args...]
set -o pipefail
scenario=$1; system=$2; backend=$3; shift 3
PX4_ROOT=${AEROPACT_PX4_ROOT:-$HOME/.cache/aeropact/px4}
set +u
source /opt/ros/jazzy/setup.bash
[ -f "$PX4_ROOT/ws/install/setup.bash" ] && source "$PX4_ROOT/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
export ROS_DOMAIN_ID=${ROS_DOMAIN_ID:-77}
run_dir=${RUN_DIR:-$HOME/.aeropact/runs/${scenario}__${system}__${backend}}
rm -rf "$run_dir"; mkdir -p "$(dirname "$run_dir")"
sys_arg=()
[ "$system" != "-" ] && sys_arg=("system:=$system")
start=$(date +%s)
timeout ${TIMEOUT:-1500} ros2 launch aeropact_bringup scenario.launch.py scenario:="$scenario" \
  backend:="$backend" run_dir:="$run_dir" "${sys_arg[@]}" "$@" > "$run_dir.launch.log" 2>&1
code=$?
echo "launch exit=$code wall=$(( $(date +%s) - start ))s run_dir=$run_dir"
if [ -f "$run_dir/metrics.json" ]; then
  python3 - "$run_dir/metrics.json" <<'EOF'
import json, sys
m = json.load(open(sys.argv[1]))
keys = ['jobs_created', 'jobs_eligible', 'delivered', 'on_time_rate', 'completion_rate',
        'duplicate_rate', 'msgs_per_drone_min']
print({k: m.get(k) for k in keys})
print('invariants', m.get('invariants'))
EOF
else
  echo "no metrics.json"; tail -30 "$run_dir.launch.log"
fi
pkill -f px4_sitl_default/bin/px4 2>/dev/null; pkill -f MicroXRCEAgent 2>/dev/null
pkill -f "gz sim" 2>/dev/null
exit 0
