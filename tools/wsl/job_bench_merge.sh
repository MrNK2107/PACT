#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: merge the benchmark shards into one summary (every run already has metrics: no reruns).
set +u
source /opt/ros/jazzy/setup.bash
source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
python3 $AEROPACT_WS/tools/wsl/bench_contaminated.py
ros2 run aeropact_eval bench \
  --matrix $AEROPACT_WS/src/aeropact_bringup/config/bench_matrix.yaml \
  --seeds 5 --out "$HOME/.cache/aeropact/bench" 2>&1 | tail -5
cat "$HOME/.cache/aeropact/bench/summary.md"
