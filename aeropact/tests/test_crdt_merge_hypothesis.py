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
Hypothesis property tests of the real C++ CRDT task merge (aeropact_core::merge_task).

The merge lives in C++, so these tests drive it through `merge_oracle`, a tiny stdin/stdout
binary built by `ci/core/CMakeLists.txt` (no ROS needed). Point AEROPACT_MERGE_ORACLE at it:

    cmake -S ci/core -B build-core && cmake --build build-core -j
    AEROPACT_MERGE_ORACLE=build-core/merge_oracle python -m pytest tests

Without the oracle the module is skipped. Complements the seeded gtest property suite
(src/aeropact_core/test/test_merge_properties.cpp) with shrinking counterexamples.
"""

import os
import subprocess

from hypothesis import given
from hypothesis import strategies as st
import pytest

ORACLE = os.environ.get('AEROPACT_MERGE_ORACLE')
pytestmark = pytest.mark.skipif(not ORACLE or not os.path.exists(ORACLE),
                                reason='AEROPACT_MERGE_ORACLE not built (see ci/core)')

UNASSIGNED, CLAIMED, COMMITTED, PICKED_UP, ABORTED, DELIVERED = range(6)
OWNERS = ['A01', 'A02', 'A03', 'A04']


@pytest.fixture(scope='module')
def oracle():
    proc = subprocess.Popen([ORACLE], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                            bufsize=1)

    def ask(line):
        proc.stdin.write(line + '\n')
        proc.stdin.flush()
        out = proc.stdout.readline().strip()
        assert out != 'ERR', line
        return out

    yield ask
    proc.stdin.close()
    proc.wait(timeout=10)


@st.composite
def task_version(draw):
    """A well-formed version of one task: epoch >= claim_epoch, owner iff owned state."""
    state = draw(st.integers(UNASSIGNED, DELIVERED))
    claim_epoch = draw(st.integers(0, 4))
    epoch = claim_epoch + draw(st.integers(0, 1))
    if state == UNASSIGNED:
        owner, bid, seq, ttl = '-', 0.0, 0, 0.0
    else:
        owner = draw(st.sampled_from(OWNERS))
        bid = draw(st.sampled_from([0.0, 10.0, 20.0, 30.0, 12.5]))
        seq = draw(st.integers(0, 3))
        ttl = draw(st.sampled_from([0.0, 20.0]))
    reason = draw(st.sampled_from(['lost_in_flight', 'lease_lapsed'])) if state == ABORTED else '-'
    return '%d %d %d %s %r %d %r %s' % (state, claim_epoch, epoch, owner, bid, seq, ttl, reason)


def merge(oracle, *vs):
    return oracle('M ' + '|'.join(vs))


def state_of(v):
    return int(v.split()[0])


def epoch_of(v):
    return int(v.split()[2])


@given(task_version())
def test_idempotent(oracle, a):
    assert merge(oracle, a, a) == merge(oracle, a)


@given(task_version(), task_version())
def test_commutative(oracle, a, b):
    assert merge(oracle, a, b) == merge(oracle, b, a)


@given(task_version(), task_version(), task_version())
def test_associative(oracle, a, b, c):
    left = merge(oracle, merge(oracle, a, b), c)
    right = merge(oracle, a, merge(oracle, b, c))
    assert left == right


@given(st.lists(task_version(), min_size=1, max_size=8), st.randoms(use_true_random=False),
       st.lists(st.integers(0, 7), max_size=6))
def test_replicas_converge_under_reorder_and_duplication(oracle, versions, rnd, dup_idx):
    """Two replicas receiving the same set of updates in any order, with duplicates, agree."""
    first = merge(oracle, *versions)
    shuffled = list(versions) + [versions[i % len(versions)] for i in dup_idx]
    rnd.shuffle(shuffled)
    assert merge(oracle, *shuffled) == first


@given(task_version(), task_version())
def test_merge_is_an_upper_bound(oracle, a, b):
    """The join dominates both inputs in the version order and never lowers the epoch."""
    m = merge(oracle, a, b)
    assert oracle('C %s|%s' % (m, a)) in ('0', '1')
    assert oracle('C %s|%s' % (m, b)) in ('0', '1')
    assert epoch_of(m) >= max(epoch_of(a), epoch_of(b))


@given(task_version(), task_version())
def test_compare_is_antisymmetric(oracle, a, b):
    assert int(oracle('C %s|%s' % (a, b))) == -int(oracle('C %s|%s' % (b, a)))


@given(st.lists(task_version(), min_size=2, max_size=6))
def test_terminal_and_picked_up_states_are_absorbing(oracle, versions):
    """Point of no return: delivered beats everything; a picked-up parcel never reopens."""
    m = state_of(merge(oracle, *versions))
    states = {state_of(v) for v in versions}
    if DELIVERED in states:
        assert m == DELIVERED
    elif states & {PICKED_UP, ABORTED}:
        assert m in (PICKED_UP, ABORTED)


@st.composite
def shard_lease(draw):
    return '%s %d %d %r' % (draw(st.sampled_from(OWNERS)), draw(st.integers(0, 4)),
                            draw(st.integers(0, 3)), draw(st.sampled_from([0.0, 20.0, 30.0])))


@given(shard_lease(), shard_lease(), shard_lease())
def test_shard_lease_order_is_a_total_order(oracle, a, b, c):
    ab, ba = int(oracle('L %s|%s' % (a, b))), int(oracle('L %s|%s' % (b, a)))
    assert ab == -ba
    assert (ab == 0) == (a == b)
    bc, ac = int(oracle('L %s|%s' % (b, c))), int(oracle('L %s|%s' % (a, c)))
    if ab >= 0 and bc >= 0:
        assert ac >= 0
