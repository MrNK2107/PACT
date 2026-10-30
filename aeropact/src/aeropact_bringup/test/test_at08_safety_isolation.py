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
"""AT-08 / I4: with the network fully down, the safety reflexes still act on local sensing."""

from acceptance import of_type, run_scenario


def test_safety_with_network_down():
    m, events, run_dir = run_scenario('at08_safety_isolation', 'pact_quorum')
    targets = [e for e in of_type(events, 'FAULT_INJECTED') if e['data']['fault'] == 'set_soc']
    assert targets, 'no drone was flying a parcel when the battery fault was due: %s' % run_dir
    victim = targets[0]['data']['args']['id']
    landings = [e for e in of_type(events, 'SAFETY_ACTION')
                if e['agent'] == victim and e['t'] >= targets[0]['t']
                and e['data'].get('action') in ('LAND_NEAREST', 'LAND_NOW')]
    assert landings, 'safety did not land %s with the network down: %s' % (victim, run_dir)
    assert m['collisions'] == 0 and m['nfz_violations'] == 0 and m['geofence_violations'] == 0
    assert not m['invariants']['I5'], m['invariants']['I5']
