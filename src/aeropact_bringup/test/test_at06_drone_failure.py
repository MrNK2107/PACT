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
"""AT-06: a failed carrier's parcel is re-ordered only after DECLARED_FAILED and re-dispatched."""

from acceptance import of_type, run_scenario


def test_drone_failure():
    m, events, run_dir = run_scenario('at06_drone_failure', 'pact_quorum')
    target = of_type(events, 'FAULT_INJECTED')
    assert target, run_dir
    victim = target[0]['data']['args']['id']
    declared = [e for e in of_type(events, 'DECLARED_FAILED') if e['data']['peer'] == victim]
    assert declared, 'failure never declared: %s' % run_dir
    reorders = of_type(events, 'TASK_REORDERED')
    assert reorders, 'lost parcel never re-ordered: %s' % run_dir
    assert m['replacements_before_declaration'] == 0
    assert min(e['t'] for e in reorders) >= min(e['t'] for e in declared)
    assert m['median_redispatch_s'] is not None and m['median_redispatch_s'] <= 30.0, (
        m['redispatch_times_s'], run_dir)
    assert m['invariants']['ok'], m['invariants']
