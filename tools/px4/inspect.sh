#!/usr/bin/env bash
# Developer helper: prints the PX4 message fields and DDS topics the vehicle interface relies on.
PX4_ROOT=${PX4_ROOT:-$HOME/.cache/aeropact/px4}
M=$PX4_ROOT/ws/src/px4_msgs/msg
for f in VehicleStatus VehicleCommand VehicleCommandAck VehicleGlobalPosition VehicleLandDetected \
  OffboardControlMode TrajectorySetpoint VehicleAttitude VehicleLocalPosition BatteryStatus; do
  echo "=== $f"
  grep -vE '^\s*#|^\s*$' "$M/$f.msg" | sed 's/#.*//' | grep -E \
    'MESSAGE_VERSION|^[a-z]|NAVIGATION_STATE_(OFFBOARD|AUTO_LAND|AUTO_RTL|AUTO_LOITER)|ARMING_STATE|VEHICLE_CMD_(COMPONENT_ARM|DO_SET_MODE|NAV_LAND|DO_FLIGHTTERM)|VEHICLE_CMD_RESULT' \
    | tr -s ' ' | tr '\n' ';'
  echo
done
echo "=== versioned msgs"; ls "$M" | grep -iE '_v[0-9]' | head
echo "=== dds_topics"; cat "$PX4_ROOT/PX4-Autopilot/src/modules/uxrce_dds_client/dds_topics.yaml" | grep -E 'topic:|type:' | tr -s ' ' | paste - - | head -60
