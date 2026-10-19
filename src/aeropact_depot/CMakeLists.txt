cmake_minimum_required(VERSION 3.16)
project(aeropact_depot)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
endif()

find_package(ament_cmake REQUIRED)
find_package(aeropact_agent REQUIRED)
find_package(aeropact_core REQUIRED)
find_package(aeropact_interfaces REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)

# Arbitration rules as a plain library so they are unit-testable without ROS.
add_library(depot_arbiter SHARED src/arbiter.cpp)
target_include_directories(depot_arbiter PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(depot_arbiter PUBLIC aeropact_core::aeropact_core)

add_library(depot_component SHARED src/depot_node.cpp)
target_link_libraries(depot_component
  depot_arbiter
  aeropact_agent::aeropact_conversions
  ${aeropact_interfaces_TARGETS}
  ${nav_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
rclcpp_components_register_node(depot_component
  PLUGIN "aeropact::depot::DepotNode"
  EXECUTABLE depot)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS depot_arbiter depot_component
  EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_arbiter test/test_arbiter.cpp)
  target_link_libraries(test_arbiter depot_arbiter)
endif()

ament_package()
