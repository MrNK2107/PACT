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
Invariant checks over an event log (PRD section 8). Each returns a list of violations.

I1  no job is delivered twice, except jobs with a logged DUPLICATE_RESOLVED
I3  no drone receives a parcel for a task after its own lease for that task (same epoch) lapsed
I5  no drone depletes its battery in the air (energy reserve kept in practice)
M5  ground-truth safety: no collision, no-fly, or geofence violation
(I2 and I6 are replica properties: unit/property tests and the convergence scenario cover them.)
"""

from collections import defaultdict
from typing import Any, Dict, List

from aeropact_eval import eventlog


def i1_no_double_delivery(events: List[Dict[str, Any]]) -> List[str]:
    root_of = {}
    for e in eventlog.of_type(events, 'TASK_CREATED'):
        d = e['data']
        root_of[d['task_id']] = d.get('replaces') or d['task_id']
    resolved = {e['data']['task_id'] for e in eventlog.of_type(events, 'DUPLICATE_RESOLVED')}
    resolved_roots = {root_of.get(t, t) for t in resolved}
    count = defaultdict(list)
    for e in eventlog.of_type(events, 'DELIVERED'):
        tid = e['data']['task_id']
        count[root_of.get(tid, tid)].append((e['agent'], tid))
    return ['I1: job %s delivered %d times by %s' % (root, len(v), v)
            for root, v in count.items() if len(v) > 1 and root not in resolved_roots]


def i3_zombie_stop(events: List[Dict[str, Any]]) -> List[str]:
    lapsed = {}
    out = []
    for e in events:
        if e['type'] == 'LEASE_LAPSED':
            lapsed[(e['agent'], e['data']['task_id'], e['data'].get('epoch'))] = e['t']
        elif e['type'] == 'PICKUP_GRANT':
            d = e['data']
            key = (d['drone'], d['task_id'], d.get('epoch'))
            if key in lapsed and lapsed[key] <= e['t']:
                out.append('I3: %s picked up %s (epoch %s) %.1fs after its lease lapsed'
                           % (d['drone'], d['task_id'], d.get('epoch'), e['t'] - lapsed[key]))
    return out


def i5_energy(events: List[Dict[str, Any]]) -> List[str]:
    return ['I5: %s depleted its battery in the air at t=%.1f' % (e['agent'], e['t'])
            for e in eventlog.of_type(events, 'BATTERY_DEPLETED') if e['data'].get('airborne')]


def safety(events: List[Dict[str, Any]]) -> List[str]:
    out = []
    for e in eventlog.of_type(events, 'COLLISION'):
        out.append('M5: collision %s/%s at t=%.1f' % (e['agent'], e['data'].get('other'), e['t']))
    for e in eventlog.of_type(events, 'NFZ_VIOLATION'):
        out.append('M5: %s entered %s at t=%.1f' % (e['agent'], e['data'].get('zone'), e['t']))
    for e in eventlog.of_type(events, 'GEOFENCE_VIOLATION'):
        out.append('M5: %s left the operating area at t=%.1f' % (e['agent'], e['t']))
    return out


def check_invariants(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    results = {'I1': i1_no_double_delivery(events), 'I3': i3_zombie_stop(events),
               'I5': i5_energy(events), 'M5': safety(events)}
    results['ok'] = not any(results[k] for k in ('I1', 'I3', 'I5', 'M5'))
    return results
