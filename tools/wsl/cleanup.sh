#!/usr/bin/env bash
# Stops leftover simulation processes (PX4 SITL, XRCE agent, Gazebo, launch graphs) and shows memory.
for pat in px4_sitl_default/bin/px4 MicroXRCEAgent "gz sim" "ros2 launch aeropact_bringup" \
  component_container parameter_bridge event_recorder lifecycle_manager kinematic_world; do
  pkill -f -- "$pat" 2>/dev/null
done
sleep 3
echo "remaining: $(pgrep -fc 'px4_sitl_default|MicroXRCEAgent|gz sim|component_container')"
free -m | head -2
