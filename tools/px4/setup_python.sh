#!/usr/bin/env bash
# Python environment for building PX4 SITL without root: a venv that also sees the system/ROS
# site-packages (colcon, rclpy), plus PX4's build-time generators and ninja.
set -euo pipefail
VENV=${PX4_VENV:-$HOME/.cache/aeropact/px4-venv}
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv --system-site-packages "$VENV"
fi
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet \
  "empy==3.3.4" jinja2 pyyaml kconfiglib jsonschema pyros-genmsg packaging numpy toml future \
  lxml psutil ninja "setuptools<70"
"$VENV/bin/python" -c "import em, jinja2, yaml, kconfiglib, jsonschema, genmsg; print('python deps ok')"
"$VENV/bin/ninja" --version
