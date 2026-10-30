#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Copies the finished benchmark from ~/.cache/aeropact/bench into the repository's results/
# (runs/ stays out of git) and regenerates the README figures from it.
set -e
WS=$AEROPACT_WS
SRC=$HOME/.cache/aeropact/bench
find "$WS/results" -mindepth 1 ! -name .gitkeep -exec rm -rf {} +
mkdir -p "$WS/results"
cp "$SRC"/summary.md "$SRC"/results.csv "$SRC"/*.png "$WS/results/"
cp -r "$SRC/runs" "$WS/results/runs"
python3 "$WS/tools/plot_results.py" --results "$WS/results" --out "$WS/docs/img"
ls -la "$WS/results" "$WS/docs/img"
