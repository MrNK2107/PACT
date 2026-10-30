cmake_minimum_required(VERSION 3.16)
project(aeropact_core)

if(NOT CMAKE_CXX_STANDARD)
  set(CMAKE_CXX_STANDARD 17)
  set(CMAKE_CXX_STANDARD_REQUIRED ON)
endif()
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
endif()

find_package(ament_cmake REQUIRED)
find_package(aeropact_geometry REQUIRED)
find_package(yaml_cpp_vendor REQUIRED)
find_package(yaml-cpp REQUIRED)

add_library(${PROJECT_NAME} SHARED
  src/types.cpp
  src/merge.cpp
  src/replica.cpp
  src/clock.cpp
  src/partition_policy.cpp
  src/ownership.cpp
  src/energy.cpp
  src/auction.cpp
  src/failure_detector.cpp
  src/hexgrid.cpp
  src/world_model.cpp
  src/route_planner.cpp
  src/task_ids.cpp
)
target_include_directories(${PROJECT_NAME} PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>
  $<INSTALL_INTERFACE:include/${PROJECT_NAME}>)
target_link_libraries(${PROJECT_NAME} PUBLIC aeropact_geometry::aeropact_geometry yaml-cpp)

install(DIRECTORY include/ DESTINATION include/${PROJECT_NAME})
install(TARGETS ${PROJECT_NAME} EXPORT export_${PROJECT_NAME}
  LIBRARY DESTINATION lib ARCHIVE DESTINATION lib RUNTIME DESTINATION bin)
ament_export_targets(export_${PROJECT_NAME} HAS_LIBRARY_TARGET)
ament_export_dependencies(aeropact_geometry yaml_cpp_vendor yaml-cpp)

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_gtest REQUIRED)
  set(core_tests
    test_merge_properties
    test_replica
    test_ownership
    test_partition_policy
    test_auction
    test_energy
    test_failure_detector
    test_hexgrid
    test_route_planner
    test_world_model
    test_clock
  )
  foreach(t ${core_tests})
    ament_add_gtest(${t} test/${t}.cpp TIMEOUT 120)
    target_link_libraries(${t} ${PROJECT_NAME})
    target_compile_definitions(${t} PRIVATE TEST_DATA_DIR="${CMAKE_CURRENT_SOURCE_DIR}/test/data")
  endforeach()
endif()

ament_package()
