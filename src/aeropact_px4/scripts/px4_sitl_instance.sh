#!/usr/bin/env bash
# Starts one PX4 SITL instance attached to an existing Gazebo model (no root, no PX4 make).
#
#   px4_sitl_instance.sh <instance> <vehicle_id> <gz_world> <work_dir> [params_file]
#
# The instance connects to the Micro XRCE-DDS Agent on UDP 8888 with the namespace <vehicle_id>,
# so its topics appear as /<vehicle_id>/fmu/{in,out}/... next to the vehicle's companion nodes.
# AEROPACT_PX4_ROOT (default ~/.cache/aeropact/px4) points at the pinned toolchain built by
# tools/px4/build_px4.sh.
#
# Parameters: the params file becomes the fleet airframe 4901_gz_aeropact_x500, which sources the
# stock Gazebo x500 airframe and then sets the fleet values as defaults. (PX4 stores only values
# that differ from the default, so a plain `param set` to the firmware default would be undone by
# the stock airframe's `param set-default`.) Per-instance values go through PX4_PARAM_*.
set -eo pipefail
if [ $# -lt 4 ]; then
  echo "usage: $0 <instance> <vehicle_id> <gz_world> <work_dir> [params_file]" >&2
  exit 2
fi
inst=$1
vehicle=$2
world=$3
work=$4
params=${5:-}
PX4_ROOT=${AEROPACT_PX4_ROOT:-$HOME/.cache/aeropact/px4}
BUILD=$PX4_ROOT/PX4-Autopilot/build/px4_sitl_default
if [ ! -x "$BUILD/bin/px4" ]; then
  echo "PX4 SITL not built at $BUILD (run tools/px4/build_px4.sh px4)" >&2
  exit 1
fi
# Gazebo paths PX4's startup scripts expect (models, plugins).
if [ -f "$BUILD/rootfs/gz_env.sh" ]; then
  # shellcheck disable=SC1091
  source "$BUILD/rootfs/gz_env.sh"
fi
unset GZ_SIM_SERVER_CONFIG_PATH  # the world file lists its own systems

mkdir -p "$work"
etc="$work/etc_overlay"
rm -rf "$etc"
cp -r "$BUILD/etc" "$etc"
airframe="$etc/init.d-posix/airframes/4901_gz_aeropact_x500"
rtl_base=60
{
  echo '#!/bin/sh'
  echo '# @name AeroPACT fleet x500 (Gazebo), generated from px4_sitl.params'
  echo '# @type Quadrotor'
  echo '. ${R}etc/init.d-posix/airframes/4001_gz_x500'
  if [ -n "$params" ]; then
    while read -r name value _; do
      case "$name" in
        ''|'#'*) continue ;;
        RTL_RETURN_ALT) rtl_base=$value; continue ;;  # per-vehicle value below
      esac
      echo "param set-default $name $value"
    done < "$params"
  fi
  # Vertically separated returns when several vehicles fall back to RTL at once.
  echo "param set-default RTL_RETURN_ALT $((${rtl_base%.*} + 4 * inst))"
} > "$airframe"
chmod +x "$airframe"

export PX4_SYS_AUTOSTART=4901
export PX4_SIMULATOR=gz
export PX4_GZ_STANDALONE=1           # Gazebo is started by the launch file, not by PX4
export PX4_GZ_WORLD="$world"
export PX4_GZ_MODEL_NAME="$vehicle"  # attach to the airframe the world already contains
export PX4_UXRCE_DDS_NS="$vehicle"
export PX4_PARAM_UXRCE_DDS_KEY=$((inst + 1))  # unique session key per client on one agent

cd "$work"
exec "$BUILD/bin/px4" -i "$inst" -d "$etc" -w "$work"
