#!/usr/bin/env bash
V=/mnt/c/Users/nanda/Desktop/projects/PACT/video/gazebo
S=/mnt/c/Users/nanda/Desktop/projects/PACT/aeropact/src/aeropact_bringup/config/film/px4_s0_healthy.yaml
bash /mnt/c/Users/nanda/Desktop/projects/PACT/aeropact/tools/wsl/cleanup.sh > /dev/null
bash /mnt/c/Users/nanda/Desktop/projects/PACT/aeropact/tools/wsl/job_film.sh px4_s0_healthy "" $S $V/gz_px4.mp4 163 px4
R=$(ls -dt ~/.aeropact/runs/px4_s0_healthy__*/ | head -1)
cp $R/events.jsonl $V/gz_px4.events.jsonl 2>/dev/null; cp $R/metrics.json $V/gz_px4.metrics.json 2>/dev/null
echo "run dir $R"; echo done
