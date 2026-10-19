cmake_minimum_required(VERSION 3.16)
project(aeropact_baselines)

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
find_package(rclcpp REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)

add_library(global_assignment SHARED src/global_assignment.cpp)
target_include_directories(global_assignment PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(global_assignment PUBLIC aeropact_core::aeropact_core)

add_library(central_planner_component SHARED src/central_planner_node.cpp)
target_link_libraries(central_planner_component
  global_assignment
  aeropact_agent::aeropact_conversions
  ${aeropact_interfaces_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
rclcpp_components_register_node(central_planner_component
  PLUGIN "aeropact::baselines::CentralPlannerNode"
  EXECUTABLE central_planner)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS global_assignment central_planner_component
  EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_global_assignment test/test_global_assignment.cpp)
  target_link_libraries(test_global_assignment global_assignment)
endif()

ament_package()
