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
"""AT-05: under hub loss PACT keeps its on-time rate while the central baseline collapses."""

from acceptance import of_type, run_scenario


def test_hub_kill():
    central, c_events, c_dir = run_scenario('at05_hub_kill', 'central')
    pact, p_events, p_dir = run_scenario('at05_hub_kill', 'pact_quorum')
    assert of_type(c_events, 'HUB_DOWN'), c_dir
    # The baseline must be a working one: it delivers while the hub is alive.
    hub_down = of_type(c_events, 'HUB_DOWN')[0]['t']
    assert [e for e in of_type(c_events, 'PICKED_UP') if e['t'] < hub_down + 120], c_dir
    assert of_type(c_events, 'DELIVERED'), c_dir
    assert pact['invariants']['ok'], pact['invariants']
    assert pact['on_time_rate'] >= 0.7, (pact['on_time_rate'], p_dir)
    assert pact['on_time_rate'] - central['on_time_rate'] >= 0.25, (
        pact['on_time_rate'], central['on_time_rate'], p_dir, c_dir)
