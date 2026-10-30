#!/usr/bin/env bash
# Prints the toolchain available in the WSL build environment.
set +e
echo "== os"; lsb_release -ds; uname -r; nproc; free -g | head -2; df -h ~ | tail -1
echo "== ros"; ls /opt/ros
echo "== gz"; gz sim --versions 2>/dev/null | head -3
echo "== tools"; for t in gcc g++ cmake ninja make git python3 pip3 colcon java ccache; do printf '%-8s ' $t; command -v $t || echo MISSING; done
python3 --version
python3 -c "import jinja2, yaml, empy" 2>&1 | head -2
python3 -c "import em; print('empy', em.__version__)" 2>&1 | head -1
echo "== sudo"; sudo -n true 2>&1 && echo "sudo ok" || echo "no passwordless sudo"
echo "== cache"; ls ~/.cache/aeropact 2>/dev/null; ls ~/.cache/aeropact/install 2>/dev/null | head -20
echo "== px4"; ls ~/PX4-Autopilot 2>/dev/null | head -3; ls ~ ; dpkg -l | grep -E "px4|mavros|microxrce|ros-jazzy-(ros-gz|mavlink)" | awk '{print $2, $3}' | head
