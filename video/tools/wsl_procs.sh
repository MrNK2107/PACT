#!/usr/bin/env bash
echo "gz: $(pgrep -f 'gz sim -s' | wc -l)  launch: $(pgrep -f 'ros2 launch aeropact_bringup' | wc -l)  film: $(pgrep -f film_director | wc -l)  containers: $(pgrep -f component_container | wc -l)"
free -m | awk 'NR==2{print "mem avail MB:", $7}'
