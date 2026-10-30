#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: full build + unit/property/lint suite.
T=$AEROPACT_WS/tools/wsl
bash "$T/run.sh" bt test > /dev/null 2>&1
grep -E 'Summary: [0-9]+ tests' "$HOME/.cache/aeropact/logs/bt.log"
grep -E " error:|Failed   <<<" "$HOME/.cache/aeropact/logs/bt.log" | head
bash "$T/failures.sh"
