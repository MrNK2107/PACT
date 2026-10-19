cmake_minimum_required(VERSION 3.16)
project(aeropact_sim)

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
find_package(diagnostic_msgs REQUIRED)
find_package(geometry_msgs REQUIRED)
find_package(lifecycle_msgs REQUIRED)
find_package(nav_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rosgraph_msgs REQUIRED)
find_package(sensor_msgs REQUIRED)
find_package(std_msgs REQUIRED)
find_package(yaml_cpp_vendor REQUIRED)
find_package(yaml-cpp REQUIRED)

# Channel and battery models as plain libraries (unit tested without ROS).
add_library(sim_models SHARED src/channel_model.cpp src/battery_model.cpp src/yaml_json.cpp)
target_include_directories(sim_models PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(sim_models PUBLIC aeropact_core::aeropact_core yaml-cpp)

set(ros_libs
  ${aeropact_interfaces_TARGETS}
  ${diagnostic_msgs_TARGETS}
  ${geometry_msgs_TARGETS}
  ${lifecycle_msgs_TARGETS}
  ${nav_msgs_TARGETS}
  ${rosgraph_msgs_TARGETS}
  ${sensor_msgs_TARGETS}
  ${std_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component)

macro(sim_component lib src plugin exe)
  add_library(${lib} SHARED ${src})
  target_link_libraries(${lib} sim_models ${ros_libs})
  rclcpp_components_register_node(${lib} PLUGIN ${plugin} EXECUTABLE ${exe})
  list(APPEND sim_components ${lib})
endmacro()

sim_component(radio_medium_component src/radio_medium_node.cpp
  "aeropact::sim::RadioMediumNode" radio_medium)
sim_component(vehicle_plant_component src/vehicle_plant_node.cpp
  "aeropact::sim::VehiclePlantNode" vehicle_plant)
sim_component(proximity_sensor_component src/proximity_sensor_node.cpp
  "aeropact::sim::ProximitySensorNode" proximity_sensor)
sim_component(kinematic_world_component src/kinematic_world_node.cpp
  "aeropact::sim::KinematicWorldNode" kinematic_world)
sim_component(fault_injector_component src/fault_injector_node.cpp
  "aeropact::sim::FaultInjectorNode" fault_injector)
sim_component(workload_generator_component src/workload_generator_node.cpp
  "aeropact::sim::WorkloadGeneratorNode" workload_generator)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS sim_models ${sim_components}
  EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
install(PROGRAMS scripts/generate_world.py DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY maps models DESTINATION share/${PROJECT_NAME})
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  # The generator writes SDF/XML programmatically; flake8 and pep257 apply to it.
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_channel_model test/test_channel_model.cpp)
  target_link_libraries(test_channel_model sim_models)
  ament_add_gtest(test_battery_model test/test_battery_model.cpp)
  target_link_libraries(test_battery_model sim_models)
  find_package(ament_cmake_pytest REQUIRED)
  ament_add_pytest_test(test_world_generator test/test_world_generator.py
    ENV GENERATOR=${CMAKE_CURRENT_SOURCE_DIR}/scripts/generate_world.py
        MAPS_DIR=${CMAKE_CURRENT_SOURCE_DIR}/maps
    TIMEOUT 120)
endif()

ament_package()
