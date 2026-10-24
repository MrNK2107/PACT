cmake_minimum_required(VERSION 3.16)
project(aeropact_px4)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
endif()

find_package(ament_cmake REQUIRED)

# Autopilot-independent logic (frames, offboard arbitration): no ROS, always built and tested.
add_library(aeropact_px4_logic SHARED src/offboard_arbiter.cpp)
target_include_directories(aeropact_px4_logic PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS aeropact_px4_logic EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
install(DIRECTORY config DESTINATION share/${PROJECT_NAME})

# The ROS component needs px4_msgs (tools/px4/build_px4.sh msgs builds the pinned underlay).
# Without it the workspace still builds; the px4 backend is then unavailable.
find_package(px4_msgs QUIET)
if(px4_msgs_FOUND)
  find_package(aeropact_interfaces REQUIRED)
  find_package(geometry_msgs REQUIRED)
  find_package(nav_msgs REQUIRED)
  find_package(sensor_msgs REQUIRED)
  find_package(std_msgs REQUIRED)
  find_package(rclcpp REQUIRED)
  find_package(rclcpp_components REQUIRED)
  find_package(rclcpp_lifecycle REQUIRED)
  add_library(px4_vehicle_interface_component SHARED src/px4_vehicle_interface_node.cpp)
  target_link_libraries(px4_vehicle_interface_component
    aeropact_px4_logic
    ${aeropact_interfaces_TARGETS}
    ${px4_msgs_TARGETS}
    ${geometry_msgs_TARGETS}
    ${nav_msgs_TARGETS}
    ${sensor_msgs_TARGETS}
    ${std_msgs_TARGETS}
    rclcpp::rclcpp
    rclcpp_components::component
    rclcpp_lifecycle::rclcpp_lifecycle)
  rclcpp_components_register_node(px4_vehicle_interface_component
    PLUGIN "aeropact::px4::Px4VehicleInterfaceNode"
    EXECUTABLE px4_vehicle_interface)
  install(TARGETS px4_vehicle_interface_component
    LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
else()
  message(WARNING "px4_msgs not found: building aeropact_px4 logic only (no vehicle interface). "
    "Run tools/px4/build_px4.sh msgs and source its install/setup.bash first.")
endif()
install(PROGRAMS scripts/px4_sitl_instance.sh DESTINATION lib/${PROJECT_NAME})

ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_frames test/test_frames.cpp)
  target_link_libraries(test_frames aeropact_px4_logic)
  ament_add_gtest(test_offboard_arbiter test/test_offboard_arbiter.cpp)
  target_link_libraries(test_offboard_arbiter aeropact_px4_logic)
endif()

ament_package()
