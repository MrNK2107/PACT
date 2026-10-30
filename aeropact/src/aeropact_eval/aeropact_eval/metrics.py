# Copyright 2026 AeroPACT Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Metrics of a run, computed from the event log only (REQ-EVAL-003, 05_evaluation_plan).

Job accounting: a *job* is an original order (TASK_CREATED without `replaces`); re-orders of lost
parcels belong to the job they replace. A job is *eligible* when its deadline falls before the end
of the run, so jobs created too late to finish do not count against any system.
"""

import argparse
from collections import defaultdict
import json
import os
import statistics
import sys
from typing import Any, Dict, List, Optional

from aeropact_eval import eventlog
from aeropact_eval.invariants import check_invariants


def _median(xs: List[float]) -> Optional[float]:
    return statistics.median(xs) if xs else None


def compute(events: List[Dict[str, Any]], end_time: Optional[float] = None) -> Dict[str, Any]:
    if end_time is None:
        end_time = max((e['t'] for e in events), default=0.0)
    created = {}
    root_of = {}
    for e in eventlog.of_type(events, 'TASK_CREATED'):
        d = e['data']
        tid = d['task_id']
        root = d.get('replaces') or tid
        root_of[tid] = root
        if not d.get('replaces'):
            created[tid] = d
    deliveries = defaultdict(list)
    for e in eventlog.of_type(events, 'DELIVERED'):
        d = e['data']
        root = root_of.get(d['task_id'], d.get('replaces') or d['task_id'])
        deliveries[root].append({'t': e['t'], 'on_time': bool(d.get('on_time')),
                                 'agent': e['agent'], 'task_id': d['task_id']})
    eligible = {tid: d for tid, d in created.items() if d['deadline'] <= end_time}
    delivered = [tid for tid in eligible if deliveries.get(tid)]
    on_time = [tid for tid in eligible if any(x['on_time'] for x in deliveries.get(tid, []))]
    by_priority = {}
    for p in (1, 2, 3):
        jobs = [tid for tid, d in eligible.items() if int(d['priority']) == p]
        ok = [tid for tid in jobs if tid in on_time]
        by_priority[p] = {'jobs': len(jobs), 'on_time': len(ok),
                          'rate': (len(ok) / len(jobs)) if jobs else None}

    duplicate_jobs = [tid for tid, ds in deliveries.items() if len(ds) > 1]
    grants = defaultdict(int)
    for e in eventlog.of_type(events, 'PICKUP_GRANT'):
        grants[e['data']['task_id']] += 1
    duplicate_dispatch = sum(1 for n in grants.values() if n > 1)
    n_jobs = len(created)

    lead_times = []
    for tid in delivered:
        first = min(x['t'] for x in deliveries[tid])
        lead_times.append(first - float(created[tid]['created_at']))

    # Recovery after drone failure: declaration -> delivery of the re-ordered parcel (AT-06, M4).
    declared = {}
    for e in eventlog.of_type(events, 'DECLARED_FAILED'):
        peer = e['data']['peer']
        declared.setdefault(peer, e['t'])
    killed = {}
    for e in eventlog.of_type(events, 'FAULT_INJECTED'):
        if e['data'].get('fault') == 'kill_drone':
            killed[e['data']['args']['id']] = e['t']
    aborted_owner = {}
    for e in eventlog.of_type(events, 'TASK_ABORTED'):
        aborted_owner.setdefault(e['data']['task_id'], (e['data'].get('owner') or e['agent'],
                                                        e['t']))
    first_claim = {}
    for e in eventlog.of_type(events, 'CLAIM', 'HUB_ASSIGNMENT', 'HUB_ASSIGN'):
        first_claim.setdefault(e['data']['task_id'], e['t'])
    recovery = []
    redispatch = []
    replacement_before_declaration = 0
    for e in eventlog.of_type(events, 'TASK_REORDERED'):
        lost = e['data']['replaces']
        owner, _ = aborted_owner.get(lost, (None, None))
        if owner is None or owner not in declared:
            continue
        if e['t'] + 1e-6 < declared[owner]:
            replacement_before_declaration += 1
        if e['data']['task_id'] in first_claim:
            redispatch.append(first_claim[e['data']['task_id']] - declared[owner])
        done = [x['t'] for x in deliveries.get(root_of.get(e['data']['task_id'], lost), [])
                if x['task_id'] == e['data']['task_id']]
        if done:
            recovery.append(min(done) - declared[owner])
    detection = [declared[d] - killed[d] for d in killed if d in declared]

    # Messaging (M6): frames per drone per minute from the medium's counters.
    stats = eventlog.of_type(events, 'RADIO_STATS')
    msgs_per_drone_min = None
    bytes_per_drone_min = None
    if stats:
        nodes = stats[-1]['data']['nodes']
        drones = {k: v for k, v in nodes.items() if not v.get('depot')}
        minutes = max(stats[-1]['t'], 1.0) / 60.0
        if drones:
            msgs_per_drone_min = statistics.mean(v['tx'] for v in drones.values()) / minutes
            bytes_per_drone_min = statistics.mean(v['tx_bytes'] for v in drones.values()) / minutes

    safety_actions = defaultdict(int)
    for e in eventlog.of_type(events, 'SAFETY_ACTION'):
        safety_actions[e['data'].get('action', '?')] += 1

    inv = check_invariants(events)
    return {
        'end_time_s': end_time,
        'jobs_created': n_jobs,
        'jobs_eligible': len(eligible),
        'jobs_delivered': len(delivered),
        'completion_rate': (len(delivered) / len(eligible)) if eligible else None,
        'on_time_rate': (len(on_time) / len(eligible)) if eligible else None,
        'on_time_by_priority': by_priority,
        'median_lead_time_s': _median(lead_times),
        'duplicate_deliveries': len(duplicate_jobs),
        'duplicate_dispatches': duplicate_dispatch,
        'duplicate_rate': (len(duplicate_jobs) / n_jobs) if n_jobs else 0.0,
        'duplicates_resolved': len(eventlog.of_type(events, 'DUPLICATE_RESOLVED')),
        'recovery_times_s': recovery,
        'median_recovery_s': _median(recovery),
        'redispatch_times_s': redispatch,
        'median_redispatch_s': _median(redispatch),
        'failure_detection_s': detection,
        'replacements_before_declaration': replacement_before_declaration,
        'lease_lapses': len(eventlog.of_type(events, 'LEASE_LAPSED')),
        'reopened_leases': len(eventlog.of_type(events, 'LEASE_EXPIRED_REOPEN')),
        'msgs_per_drone_min': msgs_per_drone_min,
        'bytes_per_drone_min': bytes_per_drone_min,
        'safety_actions': dict(safety_actions),
        'collisions': len(eventlog.of_type(events, 'COLLISION')),
        'nfz_violations': len(eventlog.of_type(events, 'NFZ_VIOLATION')),
        'geofence_violations': len(eventlog.of_type(events, 'GEOFENCE_VIOLATION')),
        'batteries_depleted': len(eventlog.of_type(events, 'BATTERY_DEPLETED')),
        'invariants': inv,
    }


def compute_run(run_dir: str, end_time: Optional[float] = None) -> Dict[str, Any]:
    events = eventlog.load(os.path.join(run_dir, 'events.jsonl'))
    return compute(events, end_time)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description='Compute AeroPACT metrics from a run directory.')
    p.add_argument('run_dir')
    p.add_argument('--end', type=float, help='run end time (default: last event)')
    a = p.parse_args(argv)
    m = compute_run(a.run_dir, a.end)
    print(json.dumps(m, indent=2, sort_keys=True))
    return 0 if m['invariants']['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
