#!/usr/bin/env bash
AEROPACT_WS=${AEROPACT_WS:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}
# Job: record a scenario in film mode. Usage: job_film.sh <scenario> <system> <shots.yaml> <out.mp4> <duration_s> [backend]
FF=/mnt/c/Users/nanda/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe
source /opt/ros/jazzy/setup.bash
[ -f "$HOME/.cache/aeropact/px4/ws/install/setup.bash" ] && source "$HOME/.cache/aeropact/px4/ws/install/setup.bash"
source "$HOME/.cache/aeropact/install/setup.bash"
export DISPLAY=${DISPLAY:-:0}
ros2 launch aeropact_bringup scenario.launch.py scenario:="$1" ${2:+system:="$2"} film:="$3" film_output:="$4" \
  duration:="$5" backend:="${6:-gazebo}" ffmpeg:="$FF"
echo "launch exit $?"
ls -la "$4" "$4.frames.csv" 2>&1
grep -h "film:" ~/.ros/log/latest/film_director*.log 2>/dev/null | tail -3
