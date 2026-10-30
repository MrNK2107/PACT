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
"""PX4 SITL: a carrier loses its motors in flight (flight termination through its autopilot)."""

from acceptance import of_type, run_scenario


def test_px4_drone_failure():
    m, events, run_dir = run_scenario('px4_s5_drone_failure', 'pact_quorum', timeout=1300,
                                      backend='px4')
    target = of_type(events, 'FAULT_INJECTED')
    assert target, run_dir
    victim = target[0]['data']['args']['id']
    # The plant's motor cut went through the vehicle interface to the autopilot.
    assert [e for e in of_type(events, 'AUTOPILOT_LINK')
            if e['agent'] == victim and e['data']['to'] == 'TERMINATED'], run_dir
    declared = [e for e in of_type(events, 'DECLARED_FAILED') if e['data']['peer'] == victim]
    assert declared, 'failure never declared: %s' % run_dir
    reorders = of_type(events, 'TASK_REORDERED')
    assert reorders, 'lost parcel never re-ordered: %s' % run_dir
    assert m['replacements_before_declaration'] == 0, run_dir
    assert min(e['t'] for e in reorders) >= min(e['t'] for e in declared), run_dir
    assert m['invariants']['ok'], (m['invariants'], run_dir)
