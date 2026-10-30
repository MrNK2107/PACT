#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: the kinematic acceptance suite (AT-03..AT-10), one scenario at a time, with a pass/fail summary.
bash "$AEROPACT_WS/tools/wsl/cleanup.sh" > /dev/null
bash "$AEROPACT_WS/tools/wsl/acceptance.sh" '^test_(at|s0)' 2>&1
