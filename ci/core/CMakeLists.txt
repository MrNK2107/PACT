# Standalone (ROS-free) build of aeropact_geometry + aeropact_core and their gtest suites.
#
# aeropact_core is middleware-independent by design, so its algorithms - the
# CRDT replica/merge, ownership leases, partition policies, CBBA auction, failure detector,
# route planner - can be built and tested on a plain Ubuntu machine without ROS 2:
#
#   sudo apt-get install -y g++ cmake libyaml-cpp-dev libgtest-dev
#   cmake -S ci/core -B build-core && cmake --build build-core -j && ctest --test-dir build-core
#
# The colcon/ament build (src/*/CMakeLists.txt) stays the source of truth; this file only mirrors
# its source and test lists. Keep them in sync when adding files.
cmake_minimum_required(VERSION 3.16)
project(aeropact_core_standalone CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(CMAKE_COMPILER_IS_GNUCXX OR CMAKE_CXX_COMPILER_ID MATCHES "Clang")
  add_compile_options(-Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion)
endif()

get_filename_component(SRC_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../src" ABSOLUTE)
set(GEOM_DIR "${SRC_ROOT}/aeropact_geometry")
set(CORE_DIR "${SRC_ROOT}/aeropact_core")

find_package(yaml-cpp REQUIRED)
find_package(GTest REQUIRED)
enable_testing()

add_library(aeropact_geometry INTERFACE)
target_include_directories(aeropact_geometry INTERFACE "${GEOM_DIR}/include")

add_library(aeropact_core STATIC
  ${CORE_DIR}/src/types.cpp
  ${CORE_DIR}/src/merge.cpp
  ${CORE_DIR}/src/replica.cpp
  ${CORE_DIR}/src/clock.cpp
  ${CORE_DIR}/src/partition_policy.cpp
  ${CORE_DIR}/src/ownership.cpp
  ${CORE_DIR}/src/energy.cpp
  ${CORE_DIR}/src/auction.cpp
  ${CORE_DIR}/src/failure_detector.cpp
  ${CORE_DIR}/src/hexgrid.cpp
  ${CORE_DIR}/src/world_model.cpp
  ${CORE_DIR}/src/route_planner.cpp
  ${CORE_DIR}/src/task_ids.cpp
)
target_include_directories(aeropact_core PUBLIC "${CORE_DIR}/include")
# yaml-cpp exports either a namespaced or a plain target depending on the distro version.
if(TARGET yaml-cpp::yaml-cpp)
  set(YAML_TARGET yaml-cpp::yaml-cpp)
else()
  set(YAML_TARGET yaml-cpp)
endif()
target_link_libraries(aeropact_core PUBLIC aeropact_geometry ${YAML_TARGET})

add_executable(test_geometry "${GEOM_DIR}/test/test_geometry.cpp")
target_link_libraries(test_geometry aeropact_geometry GTest::gtest_main)
add_test(NAME test_geometry COMMAND test_geometry)

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
  add_executable(${t} "${CORE_DIR}/test/${t}.cpp")
  target_link_libraries(${t} aeropact_core GTest::gtest_main)
  target_compile_definitions(${t} PRIVATE TEST_DATA_DIR="${CORE_DIR}/test/data")
  add_test(NAME ${t} COMMAND ${t})
  set_tests_properties(${t} PROPERTIES TIMEOUT 120)
endforeach()

# stdin/stdout oracle over the real merge functions, driven by the hypothesis property tests in
# tests/test_crdt_merge_hypothesis.py (set AEROPACT_MERGE_ORACLE=<build>/merge_oracle).
add_executable(merge_oracle "${CMAKE_CURRENT_SOURCE_DIR}/merge_oracle.cpp")
target_link_libraries(merge_oracle aeropact_core)
