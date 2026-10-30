#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: the Gazebo demo with the Gazebo GUI and RViz on the WSLg display, for recording from the Windows side.
# Usage: job_gui_demo.sh [scenario] [system] [extra launch args...]
scenario=${1:-demo_hub_loss_partition}
system=${2:-pact_quorum}
shift 2 2>/dev/null
source /opt/ros/jazzy/setup.bash
[ -f "$HOME/.cache/aeropact/px4/ws/install/setup.bash" ] && source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
export DISPLAY=${DISPLAY:-:0}
exec ros2 launch aeropact_bringup scenario.launch.py scenario:="$scenario" system:="$system" \
  backend:=gazebo gui:=true rviz:=true "$@"
