#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: benchmark shard 1 (see src/aeropact_bringup/config/bench_shard_1.yaml), 5 seeds.
set +u
source /opt/ros/jazzy/setup.bash
source $HOME/.cache/aeropact/px4/ws/install/setup.bash
source $HOME/.cache/aeropact/install/setup.bash
export ROS_DOMAIN_ID=41
ros2 run aeropact_eval bench --matrix $AEROPACT_WS/src/aeropact_bringup/config/bench_shard_1.yaml   --seeds 5 --out $HOME/.cache/aeropact/bench --timeout 1500
