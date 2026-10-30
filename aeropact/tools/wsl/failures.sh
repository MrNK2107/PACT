#!/usr/bin/env bash
# Lists failing test cases (xunit results) of the last colcon test run, with their messages.
cd "$HOME/.cache/aeropact/build" || exit 1
for f in $(grep -rlE '<(failure|error)' --include='*.xml' .); do
  echo "== $f"
  python3 - "$f" <<'EOF'
import sys
import xml.etree.ElementTree as ET
root = ET.parse(sys.argv[1]).getroot()
for case in root.iter('testcase'):
    for tag in ('failure', 'error'):
        for el in case.findall(tag):
            msg = (el.get('message') or '') + ' ' + (el.text or '')
            print('  %s %s: %s' % (tag, case.get('name'), ' '.join(msg.split())[:400]))
EOF
done
