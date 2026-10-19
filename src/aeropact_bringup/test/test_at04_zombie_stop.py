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
"""AT-04: isolated owners stop acting on their tasks; nobody picks up after a lapsed lease (I3)."""

from acceptance import of_type, run_scenario


def test_zombie_stop():
    m, events, run_dir = run_scenario('at04_zombie_stop', 'pact_quorum')
    lapses = of_type(events, 'LEASE_LAPSED')
    assert lapses, 'no lease lapsed while owners were isolated: %s' % run_dir
    assert all(32 <= e['t'] <= 160 for e in lapses), [e['t'] for e in lapses]
    assert not m['invariants']['I3'], m['invariants']['I3']
    # During isolation nobody may pick up anything.
    grants = of_type(events, 'PICKUP_GRANT')
    assert not [g for g in grants if 32 < g['t'] < 152], grants
    # After the heal the work is re-assigned under a newer epoch and delivered.
    assert m['jobs_delivered'] >= 2, (m['jobs_delivered'], run_dir)
