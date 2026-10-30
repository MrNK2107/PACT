#!/usr/bin/env bash
# Runs selected scenario acceptance tests (ctest regex) one at a time and prints pass/fail.
# Usage: acceptance.sh <ctest regex>
set +u
source /opt/ros/jazzy/setup.bash
[ -f "$HOME/.cache/aeropact/px4/ws/install/setup.bash" ] && \
  source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
cd "$HOME/.cache/aeropact/build/aeropact_bringup" || exit 1
ctest -L scenario -R "$1" --output-on-failure 2>&1 | grep -E "Test +#|tests passed|tests failed|Error|assert|FAILED|AssertionError" | head -40
