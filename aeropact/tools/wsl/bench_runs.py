"""Per-run invariant summary for bench runs matching a glob, e.g. 's0_healthy__pact_strict__*'."""
import glob
import json
import os
import sys

pattern = sys.argv[1] if len(sys.argv) > 1 else '*'
for d in sorted(glob.glob(os.path.expanduser('~/.cache/aeropact/bench/runs/' + pattern))):
    p = os.path.join(d, 'metrics.json')
    if not os.path.exists(p):
        continue
    m = json.load(open(p, encoding='utf-8'))
    inv = m['invariants']
    print(os.path.basename(d), 'dup', m.get('duplicate_deliveries'), 'ok', inv['ok'],
          {k: (v[:3] if isinstance(v, list) else v) for k, v in inv.items() if k != 'ok' and v})
