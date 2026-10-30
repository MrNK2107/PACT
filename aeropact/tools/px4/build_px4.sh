#!/usr/bin/env bash
# Builds the pinned PX4 SITL toolchain (no root needed), sequentially to bound memory:
#   1. PX4 SITL firmware (px4_sitl_default) against Gazebo Harmonic from the ROS 2 vendor packages
#   2. Micro-XRCE-DDS Agent (the bridge between PX4's uXRCE-DDS client and ROS 2)
#   3. px4_msgs as a ROS 2 underlay workspace
# Usage: build_px4.sh [px4|agent|msgs|all]   (default all). JOBS limits parallelism (default 6).
set -eo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
source "$HERE/versions.env"
PX4_ROOT=${PX4_ROOT:-$HOME/.cache/aeropact/px4}
VENV=${PX4_VENV:-$HOME/.cache/aeropact/px4-venv}
JOBS=${JOBS:-6}
what=${1:-all}

build_px4() {
  # ROS provides the gz-* CMake packages (gz_*_vendor) and their library paths.
  set +u; source /opt/ros/jazzy/setup.bash; set -u
  export PATH="$VENV/bin:$PATH"
  cd "$PX4_ROOT/PX4-Autopilot"
  make px4_sitl_default j="$JOBS"
  test -x build/px4_sitl_default/bin/px4
  echo "PX4 SITL built: $PX4_ROOT/PX4-Autopilot/build/px4_sitl_default/bin/px4"
}

build_agent() {
  # Built without ROS in the environment so the superbuild uses its own pinned Fast-DDS.
  cd "$PX4_ROOT/Micro-XRCE-DDS-Agent"
  env -i HOME="$HOME" PATH=/usr/bin:/bin bash -c "
    cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX='$PX4_ROOT/agent' \
      -DUAGENT_BUILD_EXECUTABLE=ON -DUAGENT_P2P_PROFILE=OFF &&
    cmake --build build -j$JOBS && cmake --install build"
  test -x "$PX4_ROOT/agent/bin/MicroXRCEAgent"
  echo "agent built: $PX4_ROOT/agent/bin/MicroXRCEAgent"
}

build_msgs() {
  set +u; source /opt/ros/jazzy/setup.bash; set -u
  cd "$PX4_ROOT/ws"
  MAKEFLAGS=-j$JOBS colcon build --merge-install --cmake-args -DCMAKE_BUILD_TYPE=Release
  echo "px4_msgs underlay: source $PX4_ROOT/ws/install/setup.bash"
}

case "$what" in
  px4) build_px4 ;;
  agent) build_agent ;;
  msgs) build_msgs ;;
  all) build_px4; build_agent; build_msgs ;;
  *) echo "unknown target $what"; exit 2 ;;
esac
