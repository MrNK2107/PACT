#!/usr/bin/env bash
V=/mnt/c/Users/nanda/Desktop/projects/PACT/video/gazebo
S=/mnt/c/Users/nanda/Desktop/projects/PACT/aeropact/src/aeropact_bringup/config/film/demo_hub_loss_partition.yaml
bash /mnt/c/Users/nanda/Desktop/projects/PACT/aeropact/tools/wsl/job_film.sh demo_hub_loss_partition pact_quorum $S $V/gz_demo_pact.mp4 405
cp ~/.aeropact/runs/demo_hub_loss_partition__pact_quorum__s7/events.jsonl $V/gz_demo_pact.events.jsonl 2>/dev/null
cp ~/.aeropact/runs/demo_hub_loss_partition__pact_quorum__s7/metrics.json $V/gz_demo_pact.metrics.json 2>/dev/null
echo done
