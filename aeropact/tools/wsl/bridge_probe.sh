#!/usr/bin/env bash
# Debug helper: run one mesh bridge standalone and drive its lifecycle.
set +u
source /opt/ros/jazzy/setup.bash
source "$HOME/.cache/aeropact/install/setup.bash"
export ROS_DOMAIN_ID=97
KEY=$(ros2 pkg prefix aeropact_radio)/share/aeropact_radio/config/test_fleet.key
ros2 run aeropact_radio mesh_radio_bridge --ros-args -p node_id:=A01 -p key_file:="$KEY" \
  -p mode:="${1:-unicast}" -p "peers:=[127.0.0.1:47312]" -p port:=47311 > /tmp/bridge_probe.log 2>&1 &
PID=$!
sleep 3
ros2 lifecycle set /mesh_radio_bridge configure
sleep 1
ros2 lifecycle set /mesh_radio_bridge activate
sleep 2
ros2 lifecycle get /mesh_radio_bridge
kill $PID 2>/dev/null
sleep 1
cat /tmp/bridge_probe.log
