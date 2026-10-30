#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: build, then the PX4 split-brain acceptance test.
T=$AEROPACT_WS/tools/wsl
bash "$T/run.sh" b13 build > /dev/null 2>&1
bash "$T/acceptance.sh" test_px4_s3
