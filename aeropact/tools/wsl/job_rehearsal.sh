#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: distributed SITL rehearsal of the deployment launch files (600 s, 4 orders).
bash $AEROPACT_WS/tools/px4/distributed_sitl.sh 600 4 2>&1 \
  | grep -E "^mesh auth|^order |^counts|DELIVERED|SAFETY_ACTION|RADIO_AUTH|AUTOPILOT_LINK.*OVERRIDE|PAYLOAD_"
