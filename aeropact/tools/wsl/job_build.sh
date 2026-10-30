#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: incremental build only (no tests). Optional: PACKAGES="a b".
bash "$AEROPACT_WS/tools/wsl/run.sh" build build ${PACKAGES:+PACKAGES="$PACKAGES"} | tail -5
