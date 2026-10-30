#!/usr/bin/env bash
# Keeps the WSL session attached up to $2 seconds (default 560) or until job $1 finishes, then
# prints the job's log so far.
LOG=$HOME/.cache/aeropact/logs/$1.log
end=$((SECONDS + ${2:-560}))
while [ $SECONDS -lt $end ] && [ ! -f "$LOG.done" ]; do
  sleep 15
done
[ -f "$LOG.done" ] && echo "job $1 finished (exit $(cat "$LOG.done"))" || echo "job $1 running"
cat "$LOG"
