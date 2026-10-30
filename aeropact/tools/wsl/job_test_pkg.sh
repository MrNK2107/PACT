#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: build + test selected packages only. Usage: job_test_pkg.sh <pkg> [pkg...]
source /opt/ros/jazzy/setup.bash
[ -f "$HOME/.cache/aeropact/px4/ws/install/setup.bash" ] && source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
B=$HOME/.cache/aeropact
cd "$B" || exit 1
colcon --log-base $B/log build --base-paths "$AEROPACT_WS/src" --build-base $B/build --install-base $B/install \
  --symlink-install --packages-select "$@" --cmake-args -DPython3_EXECUTABLE=/usr/bin/python3 2>&1 | tail -3
colcon --log-base $B/log test --base-paths "$AEROPACT_WS/src" --build-base $B/build --install-base $B/install \
  --packages-select "$@" --ctest-args -LE scenario 2>&1 | tail -3
colcon test-result --test-result-base $B/build --verbose 2>&1 | grep -E "Summary|failure" | head -20
