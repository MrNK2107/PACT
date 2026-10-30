"""Summarise a run's event log: counts per type and the timeline of selected event types.

Usage: python3 events.py <run_dir> [TYPE,TYPE,...] [agent]
"""
import collections
import json
import os
import sys

run_dir = sys.argv[1]
types = set(sys.argv[2].split(',')) if len(sys.argv) > 2 and sys.argv[2] else set()
agent = sys.argv[3] if len(sys.argv) > 3 else None
events = []
with open(os.path.join(run_dir, 'events.jsonl'), encoding='utf-8') as f:
    for line in f:
        events.append(json.loads(line))
counts = collections.Counter(e['type'] for e in events)
print('counts:', dict(sorted(counts.items())))
for e in events:
    if (not types or e['type'] in types) and (agent is None or e.get('agent') == agent):
        data = e.get('data', {})
        print('%8.1f %-6s %-26s %s' % (e.get('t', 0.0), e.get('agent', ''), e['type'],
                                       json.dumps(data)[:150]))
