#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: final verification on the current code - build + unit suite, every kinematic acceptance
# scenario, every PX4 acceptance scenario, then the distributed rehearsal with Ed25519 keys.
T=$AEROPACT_WS/tools/wsl
echo "== unit"
bash "$T/run.sh" final_test test > /dev/null 2>&1
grep -E 'Summary: [0-9]+ tests' "$HOME/.cache/aeropact/logs/final_test.log" | tail -1
bash "$T/failures.sh"
set +u
source /opt/ros/jazzy/setup.bash
source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
cd "$HOME/.cache/aeropact/build/aeropact_bringup" || exit 1
echo "== kinematic acceptance"
ctest -L '^scenario$' --output-on-failure 2>&1 | grep -E 'Test +#|tests passed|tests failed|Error|assert'
echo "== px4 acceptance"
ctest -L '^scenario_px4$' --output-on-failure 2>&1 | grep -E 'Test +#|tests passed|tests failed|Error|assert'
echo "== rehearsal (ed25519)"
bash "$T/job_rehearsal.sh"
echo "== done"
