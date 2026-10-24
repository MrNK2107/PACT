cmake_minimum_required(VERSION 3.16)
project(aeropact_interfaces)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(builtin_interfaces REQUIRED)
find_package(std_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)

set(msg_files
  "msg/TaskRecord.msg"
  "msg/DroneState.msg"
  "msg/PadReservation.msg"
  "msg/ShardLease.msg"
  "msg/GossipDelta.msg"
  "msg/Heartbeat.msg"
  "msg/Probe.msg"
  "msg/ProbeAck.msg"
  "msg/Distress.msg"
  "msg/Suspicion.msg"
  "msg/PadRequest.msg"
  "msg/PadResponse.msg"
  "msg/RadioFrame.msg"
  "msg/ProximityContact.msg"
  "msg/ProximityArray.msg"
  "msg/SafetyStatus.msg"
  "msg/PeerInfo.msg"
  "msg/CoordinatorStatus.msg"
  "msg/FleetEvent.msg"
  "msg/Assignment.msg"
  "msg/AssignmentArray.msg"
  "msg/AirspaceRestriction.msg"
  "msg/AirspaceRestrictionArray.msg"
  "msg/PayloadEvent.msg"
  "msg/AutopilotStatus.msg"
  "msg/PadOccupancy.msg"
)
set(srv_files
  "srv/RequestPickup.srv"
  "srv/ReserveBay.srv"
  "srv/SubmitOrder.srv"
  "srv/InjectFault.srv"
)
set(action_files
  "action/FlyRoute.action"
)

rosidl_generate_interfaces(${PROJECT_NAME}
  ${msg_files}
  ${srv_files}
  ${action_files}
  DEPENDENCIES builtin_interfaces std_msgs geometry_msgs
)

ament_export_dependencies(rosidl_default_runtime)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
endif()

ament_package()
