#!/usr/bin/env bash
# Shows PX4 failsafe / warning lines for one vehicle of a run, plus the stack's view around them.
# Usage: px4_failsafe.sh <run_dir> <vehicle>
d=$1
v=$2
echo "== PX4 console ($v)"
grep -iE "failsafe|offboard|landing|warn|lost|battery|rtl" "$d/launch.log" \
  | grep -E "px4_$v|\b$v\b" | grep -v "data writer" | tail -20 | cut -c1-240
for f in "$d"/px4/"$v"/*.log; do [ -f "$f" ] && tail -5 "$f"; done
echo "== events ($v, 380-420 s)"
python3 - "$d" "$v" <<'EOF'
import json, sys
d, v = sys.argv[1:3]
for line in open(d + '/events.jsonl'):
    e = json.loads(line)
    if e.get('agent') == v and 370 <= e['t'] <= 420 and e['type'] not in ('STATUS', 'RADIO_STATS'):
        print('%7.1f %-22s %s' % (e['t'], e['type'], json.dumps(e['data'])[:170]))
EOF
