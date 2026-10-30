"""Finds bench runs whose event log holds more than one simulation (a task created twice).

With --delete, removes those run directories so the bench runner reruns them.
"""
import collections
import glob
import json
import os
import shutil
import sys

for d in sorted(glob.glob(os.path.expanduser('~/.cache/aeropact/bench/runs/*'))):
    p = os.path.join(d, 'events.jsonl')
    if not os.path.exists(p):
        continue
    created = collections.Counter()
    with open(p, encoding='utf-8') as f:
        for line in f:
            e = json.loads(line)
            if e['type'] == 'TASK_CREATED':
                created[e['data']['task_id']] += 1
    repeated = sum(1 for c in created.values() if c > 1)
    if repeated:
        print('CONTAMINATED', os.path.basename(d), 'tasks created twice:', repeated)
        if '--delete' in sys.argv:
            shutil.rmtree(d)
            print('  deleted')
