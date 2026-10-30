#!/usr/bin/env bash
# Keeps this WSL session attached for up to $1 seconds (default 560) so the VM's idle timeout
# cannot stop detached jobs; returns early when every bench shard has finished. Prints progress.
end=$((SECONDS + ${1:-560}))
while [ $SECONDS -lt $end ]; do
  done_n=$(ls ~/.cache/aeropact/logs/bench_[123].log.done 2>/dev/null | wc -l)
  [ "$done_n" -ge 3 ] && break
  sleep 20
done
echo "runs done: $(ls ~/.cache/aeropact/bench/runs/*/metrics.json 2>/dev/null | wc -l)/90, shards finished: $done_n/3, $(free -m | awk 'NR==2{print $7}') MB available"
grep -h "\[bench\]   on-time" ~/.cache/aeropact/logs/bench_[123].log 2>/dev/null | wc -l
