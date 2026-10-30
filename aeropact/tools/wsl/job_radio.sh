#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: build and test aeropact_radio only.
T=$AEROPACT_WS/tools/wsl
bash "$T/run.sh" radio test PACKAGES=aeropact_radio > /dev/null 2>&1
grep -E 'Summary: [0-9]+ tests' "$HOME/.cache/aeropact/logs/radio.log"
grep -E "error:" "$HOME/.cache/aeropact/logs/radio.log" | head
bash "$T/failures.sh" | grep -A3 radio
