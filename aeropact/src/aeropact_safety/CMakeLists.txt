cmake_minimum_required(VERSION 3.16)
project(aeropact_safety)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
endif()

find_package(ament_cmake REQUIRED)
find_package(aeropact_geometry REQUIRED)
find_package(aeropact_interfaces REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)
find_package(yaml_cpp_vendor REQUIRED)
find_package(yaml-cpp REQUIRED)

# Pure decision logic: no ROS, testable with the network model absent by construction.
add_library(aeropact_safety_logic SHARED src/supervisor.cpp src/geofence.cpp)
target_include_directories(aeropact_safety_logic PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(aeropact_safety_logic PUBLIC aeropact_geometry::aeropact_geometry yaml-cpp)

add_library(safety_supervisor_component SHARED src/safety_supervisor_node.cpp)
target_link_libraries(safety_supervisor_component
  aeropact_safety_logic
  ${aeropact_interfaces_TARGETS}
  ${geometry_msgs_TARGETS}
  ${nav_msgs_TARGETS}
  ${sensor_msgs_TARGETS}
  ${std_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
rclcpp_components_register_node(safety_supervisor_component
  PLUGIN "aeropact::safety::SafetySupervisorNode"
  EXECUTABLE safety_supervisor)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS aeropact_safety_logic safety_supervisor_component
  EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
install(DIRECTORY config DESTINATION share/${PROJECT_NAME})
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)
ament_export_dependencies(aeropact_geometry yaml_cpp_vendor yaml-cpp)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_supervisor test/test_supervisor.cpp)
  target_link_libraries(test_supervisor aeropact_safety_logic)
  ament_add_gtest(test_independence test/test_independence.cpp)
  target_compile_definitions(test_independence PRIVATE
    PACKAGE_DIR="${CMAKE_CURRENT_SOURCE_DIR}")
endif()

ament_package()
