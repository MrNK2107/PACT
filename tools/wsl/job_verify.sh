#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: full rebuild + unit/property/lint suite, then every kinematic acceptance scenario.
T=$AEROPACT_WS/tools/wsl
bash "$T/run.sh" verify_test test > /dev/null 2>&1
grep -E 'Summary: [0-9]+ tests' "$HOME/.cache/aeropact/logs/verify_test.log"
bash "$T/failures.sh"
set +u
source /opt/ros/jazzy/setup.bash
source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
cd "$HOME/.cache/aeropact/build/aeropact_bringup" || exit 1
ctest -L '^scenario$' --output-on-failure 2>&1 | grep -E 'Test +#|tests passed|tests failed|Error|assert'
