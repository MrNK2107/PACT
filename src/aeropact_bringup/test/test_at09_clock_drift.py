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
"""AT-09: 1 % clock drift on two drones causes no zombie pickup (I3) and no double delivery."""

from acceptance import of_type, run_scenario


def test_clock_drift():
    m, events, run_dir = run_scenario('at09_clock_drift', 'pact_quorum')
    applied = [e for e in of_type(events, 'FAULT_APPLIED')
               if e['data'].get('type') == 'clock_drift']
    assert len(applied) == 2, run_dir
    assert not m['invariants']['I3'], m['invariants']['I3']
    assert not m['invariants']['I1'], m['invariants']['I1']
    assert m['jobs_eligible'] >= 5, (m['jobs_eligible'], run_dir)
    assert m['completion_rate'] >= 0.85, (m['completion_rate'], run_dir)
