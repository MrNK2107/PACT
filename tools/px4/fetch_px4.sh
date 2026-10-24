#!/usr/bin/env bash
# Fetches the pinned PX4 SITL toolchain sources into $PX4_ROOT (default ~/.cache/aeropact/px4).
# Network only; building is done by build_px4.sh. Versions are pinned in versions.env.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/versions.env"
PX4_ROOT=${PX4_ROOT:-$HOME/.cache/aeropact/px4}
mkdir -p "$PX4_ROOT"
cd "$PX4_ROOT"

if [ ! -d PX4-Autopilot/.git ]; then
  git clone --depth 1 --branch "$PX4_VERSION" --recurse-submodules --shallow-submodules \
    https://github.com/PX4/PX4-Autopilot.git
fi
# Shallow submodules carry no tags, but PX4's version header reads the NuttX tag. SITL does not
# run NuttX; a local tag only satisfies the version script.
if [ -z "$(git -C PX4-Autopilot/platforms/nuttx/NuttX/nuttx tag -l 'nuttx-*')" ]; then
  git -C PX4-Autopilot/platforms/nuttx/NuttX/nuttx tag nuttx-11.0.0
fi
if [ ! -d Micro-XRCE-DDS-Agent/.git ]; then
  git clone --depth 1 --branch "$XRCE_AGENT_VERSION" \
    https://github.com/eProsima/Micro-XRCE-DDS-Agent.git
fi
if [ ! -d ws/src/px4_msgs/.git ]; then
  mkdir -p ws/src
  git clone --depth 1 --branch "$PX4_MSGS_BRANCH" https://github.com/PX4/px4_msgs.git ws/src/px4_msgs
fi
echo "fetched into $PX4_ROOT"
