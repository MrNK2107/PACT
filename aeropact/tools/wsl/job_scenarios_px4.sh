#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: the PX4 SITL acceptance scenarios, one at a time, with a pass/fail summary.
bash "$AEROPACT_WS/tools/wsl/cleanup.sh" > /dev/null
bash "$AEROPACT_WS/tools/wsl/acceptance.sh" '^test_px4' 2>&1
