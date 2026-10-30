#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: rebuild, then the PX4 healthy acceptance test. Run detached via start_job.sh.
T=$AEROPACT_WS/tools/wsl
bash "$T/run.sh" build7 build > /dev/null 2>&1
bash "$T/acceptance.sh" test_px4_s0
