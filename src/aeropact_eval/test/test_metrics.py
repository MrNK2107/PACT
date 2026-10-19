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
"""Metrics and invariant checks on synthetic event logs."""

from aeropact_eval import metrics
from aeropact_eval.invariants import check_invariants


def ev(t, agent, etype, **data):
    return {'t': t, 'agent': agent, 'type': etype, 'data': data}


def created(t, tid, deadline, priority=2, replaces=''):
    return ev(t, 'D1', 'TASK_CREATED', task_id=tid, deadline=deadline, created_at=t,
              priority=priority, replaces=replaces, drop_x=0.0, drop_y=0.0)


def test_on_time_and_eligibility():
    events = [
        created(0, 'T1', 100), created(0, 'T2', 100), created(0, 'T3', 900),
        ev(50, 'A01', 'DELIVERED', task_id='T1', on_time=True),
        ev(150, 'A02', 'DELIVERED', task_id='T2', on_time=False),
    ]
    m = metrics.compute(events, end_time=200)
    assert m['jobs_eligible'] == 2  # T3's deadline is after the end
    assert m['on_time_rate'] == 0.5
    assert m['completion_rate'] == 1.0
    assert m['invariants']['ok']


def test_double_delivery_violates_i1_unless_resolved():
    events = [created(0, 'T1', 100), ev(50, 'A01', 'DELIVERED', task_id='T1', on_time=True),
              ev(60, 'A02', 'DELIVERED', task_id='T1', on_time=True)]
    inv = check_invariants(events)
    assert not inv['ok'] and inv['I1']
    events.append(ev(55, 'A02', 'DUPLICATE_RESOLVED', task_id='T1', winner='A01'))
    assert check_invariants(events)['ok']


def test_replacement_counts_for_the_original_job():
    events = [
        created(0, 'T1', 300),
        ev(100, 'A03', 'TASK_ABORTED', task_id='T1', owner='A01', reason='lost_in_flight'),
        ev(90, 'A03', 'DECLARED_FAILED', peer='A01', reason='quorum_with_evidence'),
        ev(101, 'D1', 'TASK_REORDERED', task_id='T1-R', replaces='T1'),
        created(101, 'T1-R', 300, replaces='T1'),
        ev(104, 'A02', 'CLAIM', task_id='T1-R', epoch=1),
        ev(200, 'A02', 'DELIVERED', task_id='T1-R', on_time=True),
    ]
    m = metrics.compute(events, end_time=400)
    assert m['jobs_created'] == 1
    assert m['on_time_rate'] == 1.0
    assert m['duplicate_deliveries'] == 0
    assert m['recovery_times_s'] == [110]
    assert m['redispatch_times_s'] == [14]
    assert m['replacements_before_declaration'] == 0


def test_zombie_pickup_violates_i3():
    events = [ev(10, 'A01', 'LEASE_LAPSED', task_id='T1', epoch=2),
              ev(20, 'D1', 'PICKUP_GRANT', task_id='T1', drone='A01', epoch=2)]
    assert check_invariants(events)['I3']
    ok = [ev(10, 'A01', 'LEASE_LAPSED', task_id='T1', epoch=2),
          ev(20, 'D1', 'PICKUP_GRANT', task_id='T1', drone='A02', epoch=3)]
    assert not check_invariants(ok)['I3']


def test_message_rate_from_radio_stats():
    events = [ev(120, 'radio_medium', 'RADIO_STATS', queue=0, nodes={
        'A01': {'tx': 200, 'tx_bytes': 20000, 'rx': 0, 'rx_bytes': 0, 'depot': False},
        'A02': {'tx': 100, 'tx_bytes': 10000, 'rx': 0, 'rx_bytes': 0, 'depot': False},
        'D1': {'tx': 999, 'tx_bytes': 1, 'rx': 0, 'rx_bytes': 0, 'depot': True}})]
    m = metrics.compute(events, end_time=120)
    assert m['msgs_per_drone_min'] == 75.0


def test_safety_events_fail_invariants():
    events = [ev(5, 'A01', 'COLLISION', other='A02', distance=0.5)]
    assert not check_invariants(events)['ok']
