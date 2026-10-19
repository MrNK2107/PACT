cmake_minimum_required(VERSION 3.16)
project(aeropact_bringup)

find_package(ament_cmake REQUIRED)

install(DIRECTORY launch config scenarios rviz DESTINATION share/${PROJECT_NAME})

if(BUILD_TESTING)
  find_package(ament_lint_auto REQUIRED)
  ament_lint_auto_find_test_dependencies()
  find_package(ament_cmake_pytest REQUIRED)
  # Scenario acceptance tests: full ROS 2 stack, kinematic backend, run with `make scenarios`.
  set(acceptance
    test_at03_split_brain
    test_at04_zombie_stop
    test_at05_hub_kill
    test_at06_drone_failure
    test_at07_energy
    test_at08_safety_isolation
    test_at09_clock_drift
    test_at10_heal_converge
    test_s0_healthy)
  foreach(t ${acceptance})
    ament_add_pytest_test(${t} test/${t}.py TIMEOUT 1500
      WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/test)
    set_tests_properties(${t} PROPERTIES LABELS "scenario")
  endforeach()
endif()

ament_package()
