cmake_minimum_required(VERSION 3.16)
project(aeropact_agent)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
endif()

find_package(ament_cmake REQUIRED)
find_package(aeropact_core REQUIRED)
find_package(aeropact_interfaces REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(lifecycle_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_action REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(std_srvs REQUIRED)

# Message <-> domain conversions, shared with the depot and the baselines.
add_library(aeropact_conversions SHARED src/conversions.cpp)
target_include_directories(aeropact_conversions PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(aeropact_conversions PUBLIC
  aeropact_core::aeropact_core
  ${aeropact_interfaces_TARGETS}
  ${geometry_msgs_TARGETS})

add_library(coordinator_component SHARED src/coordinator_node.cpp src/mission.cpp)
target_link_libraries(coordinator_component
  aeropact_conversions
  ${aeropact_interfaces_TARGETS}
  ${geometry_msgs_TARGETS}
  ${nav_msgs_TARGETS}
  ${sensor_msgs_TARGETS}
  ${std_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_action::rclcpp_action
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
rclcpp_components_register_node(coordinator_component
  PLUGIN "aeropact::agent::CoordinatorNode"
  EXECUTABLE coordinator)

add_library(flight_manager_component SHARED src/flight_manager_node.cpp)
target_link_libraries(flight_manager_component
  aeropact_core::aeropact_core
  ${aeropact_interfaces_TARGETS}
  ${geometry_msgs_TARGETS}
  ${nav_msgs_TARGETS}
  ${std_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_action::rclcpp_action
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
rclcpp_components_register_node(flight_manager_component
  PLUGIN "aeropact::agent::FlightManagerNode"
  EXECUTABLE flight_manager)

add_library(lifecycle_manager_component SHARED src/lifecycle_manager_node.cpp)
target_link_libraries(lifecycle_manager_component
  ${aeropact_interfaces_TARGETS}
  ${lifecycle_msgs_TARGETS}
  ${std_msgs_TARGETS}
  ${std_srvs_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component)
target_include_directories(lifecycle_manager_component PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
rclcpp_components_register_node(lifecycle_manager_component
  PLUGIN "aeropact::agent::LifecycleManagerNode"
  EXECUTABLE lifecycle_manager)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS aeropact_conversions coordinator_component flight_manager_component
  lifecycle_manager_component
  EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)
ament_export_dependencies(aeropact_core aeropact_interfaces geometry_msgs)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_conversions test/test_conversions.cpp)
  target_link_libraries(test_conversions aeropact_conversions)
  ament_add_gtest(test_mission test/test_mission.cpp src/mission.cpp)
  target_include_directories(test_mission PRIVATE src)
  target_link_libraries(test_mission aeropact_conversions)
endif()

ament_package()
