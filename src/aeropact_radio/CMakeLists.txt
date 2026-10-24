cmake_minimum_required(VERSION 3.16)
project(aeropact_radio)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow)
endif()

find_package(ament_cmake REQUIRED)
find_package(OpenSSL REQUIRED)
find_package(aeropact_interfaces REQUIRED)
find_package(diagnostic_msgs REQUIRED)
find_package(rclcpp REQUIRED)
find_package(rclcpp_components REQUIRED)
find_package(rclcpp_lifecycle REQUIRED)

# Envelope codec, HMAC and replay window: no ROS.
add_library(aeropact_radio_codec SHARED src/frame_codec.cpp)
target_include_directories(aeropact_radio_codec PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(aeropact_radio_codec PUBLIC OpenSSL::Crypto)

set(bridge_deps
  aeropact_radio_codec
  ${aeropact_interfaces_TARGETS}
  ${diagnostic_msgs_TARGETS}
  rclcpp::rclcpp
  rclcpp_components::component
  rclcpp_lifecycle::rclcpp_lifecycle)
add_library(mesh_radio_bridge_component SHARED src/mesh_radio_bridge_node.cpp)
target_link_libraries(mesh_radio_bridge_component ${bridge_deps})
rclcpp_components_register_node(mesh_radio_bridge_component
  PLUGIN "aeropact::radio::MeshRadioBridgeNode"
  EXECUTABLE mesh_radio_bridge)

add_executable(fleet_keygen src/fleet_keygen.cpp)
target_link_libraries(fleet_keygen aeropact_radio_codec)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS aeropact_radio_codec mesh_radio_bridge_component EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
install(TARGETS fleet_keygen DESTINATION lib/${PROJECT_NAME})
install(DIRECTORY config DESTINATION share/${PROJECT_NAME})
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)
ament_export_dependencies(OpenSSL)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  ament_add_gtest(test_frame_codec test/test_frame_codec.cpp)
  target_link_libraries(test_frame_codec aeropact_radio_codec)
  ament_add_gtest(test_bridge_loopback test/test_bridge_loopback.cpp TIMEOUT 120)
  target_link_libraries(test_bridge_loopback ${bridge_deps})
endif()

ament_package()
