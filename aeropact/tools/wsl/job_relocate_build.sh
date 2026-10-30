#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: the workspace moved (CMake caches record the old source path). Keep the previous build trees
# as *.prev, then build and run the unit suite from the current location.
B=$HOME/.cache/aeropact
for d in build install log; do
  if [ -d "$B/$d" ]; then rm -rf "$B/$d.prev"; mv "$B/$d" "$B/$d.prev"; fi
done
echo "workspace: $AEROPACT_WS"
bash "$AEROPACT_WS/tools/wsl/job_build_test.sh"
