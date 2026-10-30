#!/usr/bin/env bash
# Stops running benchmark shards and their launch graphs.
pkill -f "aeropact_eval bench" 2>/dev/null
pkill -f "lib/aeropact_eval/bench" 2>/dev/null
sleep 2
bash "$(dirname "$0")/cleanup.sh"
