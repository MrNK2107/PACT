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
"""Property tests (hypothesis) for the ROS-free eval layer: event log, invariants, metrics."""

import json
import math

from hypothesis import given
from hypothesis import strategies as st

from aeropact_eval import bench, eventlog, metrics
from aeropact_eval.invariants import check_invariants

TASKS = ['T%d' % i for i in range(6)]
DRONES = ['A01', 'A02', 'A03']
times = st.floats(0, 1000, allow_nan=False, allow_infinity=False).map(lambda t: round(t, 3))


def ev(t, agent, etype, **data):
    return {'t': t, 'agent': agent, 'type': etype, 'data': data}


@st.composite
def run_log(draw):
    """A random but schema-valid event log over a handful of jobs."""
    events = []
    jobs = draw(st.lists(st.sampled_from(TASKS), min_size=1, max_size=6, unique=True))
    for tid in jobs:
        t0 = draw(times)
        events.append(ev(t0, 'D1', 'TASK_CREATED', task_id=tid, created_at=t0,
                         deadline=t0 + draw(st.floats(10, 600)), replaces='',
                         priority=draw(st.integers(1, 3))))
    for _ in range(draw(st.integers(0, 10))):
        events.append(ev(draw(times), draw(st.sampled_from(DRONES)), 'DELIVERED',
                         task_id=draw(st.sampled_from(jobs)), on_time=draw(st.booleans())))
    for _ in range(draw(st.integers(0, 4))):
        events.append(ev(draw(times), 'D1', 'PICKUP_GRANT', task_id=draw(st.sampled_from(jobs)),
                         drone=draw(st.sampled_from(DRONES)), epoch=draw(st.integers(0, 3))))
    for _ in range(draw(st.integers(0, 3))):
        events.append(ev(draw(times), draw(st.sampled_from(DRONES)), 'LEASE_LAPSED',
                         task_id=draw(st.sampled_from(jobs)), epoch=draw(st.integers(0, 3))))
    return events


def by_time(events):
    return sorted(events, key=lambda e: e['t'])


# ---------------------------------------------------------------- event log


@given(times, st.sampled_from(DRONES), st.sampled_from(['DELIVERED', 'CLAIM']),
       st.dictionaries(st.text(min_size=1, max_size=5), st.integers() | st.text(max_size=8),
                       max_size=4))
def test_dump_line_round_trips(t, agent, etype, data):
    line = eventlog.dump_line(t, agent, etype, data)
    assert '\n' not in line
    assert json.loads(line) == {'t': round(t, 3), 'agent': agent, 'type': etype, 'data': data}


@given(run_log())
def test_load_sorts_by_time_and_keeps_every_event(tmp_path_factory, events):
    path = tmp_path_factory.mktemp('log') / 'events.jsonl'
    path.write_text('\n'.join(eventlog.dump_line(e['t'], e['agent'], e['type'], e['data'])
                              for e in events) + '\n\n', encoding='utf-8')
    loaded = eventlog.load(str(path))
    assert len(loaded) == len(events)
    assert [e['t'] for e in loaded] == sorted(e['t'] for e in events)


# ---------------------------------------------------------------- invariants


@given(run_log(), st.randoms(use_true_random=False))
def test_i1_does_not_depend_on_event_order(events, rnd):
    shuffled = list(events)
    rnd.shuffle(shuffled)

    def flagged(evs):  # "I1: job T0 delivered 2 times by [...]": compare job + count only
        return sorted(v.split(' by ')[0] for v in check_invariants(evs)['I1'])

    assert flagged(events) == flagged(shuffled)


@given(run_log())
def test_i1_flags_exactly_the_unresolved_multi_delivered_jobs(events):
    counts = {}
    for e in eventlog.of_type(events, 'DELIVERED'):
        counts[e['data']['task_id']] = counts.get(e['data']['task_id'], 0) + 1
    assert len(check_invariants(events)['I1']) == sum(1 for n in counts.values() if n > 1)
    resolved = events + [ev(1001, 'D1', 'DUPLICATE_RESOLVED', task_id=t) for t in counts]
    assert check_invariants(resolved)['I1'] == []


@given(run_log())
def test_i3_only_flags_grants_after_a_lapse_of_the_same_lease(events):
    events = by_time(events)
    lapses = [(e['agent'], e['data']['task_id'], e['data']['epoch'], e['t'])
              for e in eventlog.of_type(events, 'LEASE_LAPSED')]
    upper_bound = sum(
        1 for g in eventlog.of_type(events, 'PICKUP_GRANT')
        if any((d, tid, ep) == (g['data']['drone'], g['data']['task_id'], g['data']['epoch'])
               and t <= g['t'] for d, tid, ep, t in lapses))
    # Equal timestamps keep log order, so a lapse logged after a same-time grant is not counted.
    assert len(check_invariants(events)['I3']) <= upper_bound
    no_lapses = [e for e in events if e['type'] != 'LEASE_LAPSED']
    assert check_invariants(no_lapses)['I3'] == []


@given(run_log(), st.sampled_from(['COLLISION', 'NFZ_VIOLATION', 'GEOFENCE_VIOLATION']))
def test_any_safety_event_fails_the_run(events, etype):
    assert not check_invariants(events + [ev(5.0, 'A01', etype, other='A02', zone='Z1')])['ok']


# ---------------------------------------------------------------- metrics


@given(run_log(), st.one_of(st.none(), times))
def test_rates_are_bounded_and_consistent(events, end):
    m = metrics.compute(by_time(events), end_time=end)
    assert 0 <= m['jobs_delivered'] <= m['jobs_eligible'] <= m['jobs_created']
    if m['jobs_eligible']:
        assert 0.0 <= m['on_time_rate'] <= m['completion_rate'] <= 1.0
    else:
        assert m['on_time_rate'] is None and m['completion_rate'] is None
    assert 0.0 <= m['duplicate_rate'] <= 1.0
    assert sum(p['jobs'] for p in m['on_time_by_priority'].values()) == m['jobs_eligible']
    inv = m['invariants']
    assert inv['ok'] == (not any(inv[k] for k in ('I1', 'I3', 'I5', 'M5')))


@given(run_log(), st.randoms(use_true_random=False))
def test_metrics_do_not_depend_on_input_order_once_sorted(events, rnd):
    """compute() sees time-sorted logs (eventlog.load sorts); tie order must not matter."""
    shuffled = list(events)
    rnd.shuffle(shuffled)
    a = metrics.compute(by_time(events), end_time=1200)
    b = metrics.compute(by_time(shuffled), end_time=1200)
    for k in ('jobs_created', 'jobs_eligible', 'jobs_delivered', 'completion_rate',
              'on_time_rate', 'duplicate_deliveries', 'duplicate_dispatches'):
        assert a[k] == b[k], k


@given(run_log(), times, times)
def test_later_end_never_reduces_eligible_jobs(events, e1, e2):
    lo, hi = sorted((e1, e2))
    assert (metrics.compute(by_time(events), end_time=lo)['jobs_eligible']
            <= metrics.compute(by_time(events), end_time=hi)['jobs_eligible'])


# ---------------------------------------------------------------- benchmark statistics


@given(st.lists(st.one_of(st.none(), st.floats(0, 1)), max_size=12))
def test_ci95_brackets_the_mean(xs):
    mean, half = bench.ci95(xs)
    vals = [x for x in xs if x is not None]
    if not vals:
        assert (mean, half) == (None, None)
        return
    assert min(vals) - 1e-9 <= mean <= max(vals) + 1e-9
    assert half >= 0.0 and math.isfinite(half)
    if len(set(vals)) == 1:
        assert half <= 1e-9
