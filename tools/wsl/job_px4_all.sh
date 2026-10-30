#!/usr/bin/env bash
# Job: every PX4-in-the-loop acceptance test, one at a time.
set +u
source /opt/ros/jazzy/setup.bash
source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
cd "$HOME/.cache/aeropact/build/aeropact_bringup" || exit 1
ctest -L '^scenario_px4$' --output-on-failure 2>&1 | grep -E 'Test +#|tests passed|tests failed|Error|assert'
