#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Starts the three benchmark shards detached (fresh logs). Results resume from ~/.cache/aeropact/bench.
T=$AEROPACT_WS/tools/wsl
rm -f "$HOME"/.cache/aeropact/logs/bench_*.log "$HOME"/.cache/aeropact/logs/bench_*.log.done
for i in 1 2 3; do
  bash "$T/start_job.sh" "$T/job_bench_$i.sh" "bench_$i"
done
