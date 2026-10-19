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
AT-10 / I6: after the partition heals and the order stream stops, all replicas converge.

The recorder samples every replica's task digest on a common 5 s grid. Convergence means a sample
round where all six digests agree within T_converge (60 s) of the heal. Afterwards replicas may
briefly differ again while each one garbage-collects old terminal tasks on its own schedule; that
is housekeeping, not divergence, so the test does not sample at an arbitrary instant.
"""

from collections import defaultdict

from acceptance import of_type, run_scenario

HEAL_T = 200.0
T_CONVERGE = 60.0


def test_heal_and_converge():
    m, events, run_dir = run_scenario('at10_heal_converge', 'pact_quorum')
    rounds = defaultdict(dict)
    for e in of_type(events, 'STATUS'):
        rounds[round(e['t'])][e['agent']] = e['data']['digest']
    agreed = sorted(t for t, ds in rounds.items()
                    if t >= HEAL_T and len(ds) == 6 and len(set(ds.values())) == 1)
    assert agreed, ('replicas never agreed after the heal', run_dir)
    assert agreed[0] - HEAL_T <= T_CONVERGE, (agreed[0], run_dir)
    assert m['invariants']['ok'], m['invariants']
