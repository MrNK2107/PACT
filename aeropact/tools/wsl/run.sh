#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Runs a make target of the AeroPACT workspace inside WSL and tees the output to a log.
# Usage: run.sh <logname> <make args...>
set -o pipefail
WS=$AEROPACT_WS
LOGDIR=$HOME/.cache/aeropact/logs
mkdir -p "$LOGDIR"
name=$1; shift
export PATH=$HOME/.local/bin:$PATH
make -C "$WS" "$@" 2>&1 | tee "$LOGDIR/$name.log" | tail -n 60
echo "EXIT=${PIPESTATUS[0]}"
