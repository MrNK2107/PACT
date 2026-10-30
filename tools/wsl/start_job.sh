#!/usr/bin/env bash
# Starts a job script detached inside WSL. Usage: start_job.sh <script> <name>
# Output: ~/.cache/aeropact/logs/<name>.log; exit code in <name>.done when finished.
script=$1
name=$2
LOG=$HOME/.cache/aeropact/logs/$name.log
mkdir -p "$(dirname "$LOG")"
rm -f "$LOG" "$LOG.done"
setsid nohup bash -c 'bash "$1" > "$2" 2>&1; echo $? > "$2.done"' _ "$script" "$LOG" \
  > /dev/null 2>&1 < /dev/null &
sleep 1
echo "started $name pid $! (log $LOG)"
