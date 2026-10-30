"""Mean on-time rate and duplicates per scenario x system over finished bench runs."""
import collections
import glob
import json
import os
import statistics

rows = collections.defaultdict(list)
for path in glob.glob(os.path.expanduser('~/.cache/aeropact/bench/runs/*/metrics.json')):
    scenario, system, _ = os.path.basename(os.path.dirname(path)).split('__')
    m = json.load(open(path, encoding='utf-8'))
    rows[(scenario, system)].append((m.get('on_time_rate'), m.get('duplicate_deliveries', 0),
                                     m['invariants']['ok']))
for (scenario, system), v in sorted(rows.items()):
    ot = [x[0] for x in v if x[0] is not None]
    print('%-16s %-16s n=%d on_time=%.3f dup=%d inv_ok=%d/%d' % (
        scenario, system, len(v), statistics.mean(ot) if ot else float('nan'),
        sum(x[1] for x in v), sum(x[2] for x in v), len(v)))
