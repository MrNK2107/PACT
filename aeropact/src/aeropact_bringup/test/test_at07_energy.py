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
"""AT-07: a fast-draining drone recharges or lands; no battery is depleted in the air (I5)."""

from acceptance import of_type, run_scenario


def test_energy():
    m, events, run_dir = run_scenario('at07_energy', 'pact_quorum')
    assert not m['invariants']['I5'], m['invariants']['I5']
    a01_charging = [e for e in of_type(events, 'CHARGING_START') if e['agent'] == 'A01'
                    and e['t'] > 60]
    a01_landing = [e for e in of_type(events, 'SAFETY_ACTION') if e['agent'] == 'A01'
                   and e['data'].get('action', '').startswith('LAND')]
    assert a01_charging or a01_landing, 'A01 neither recharged nor landed: %s' % run_dir
    assert m['jobs_delivered'] >= 3, (m['jobs_delivered'], run_dir)
