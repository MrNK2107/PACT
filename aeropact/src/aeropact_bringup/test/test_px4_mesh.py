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
"""PX4 SITL over the deployed transport: authenticated mesh bridges instead of the radio model."""

from acceptance import of_type, run_scenario


def test_px4_over_authenticated_mesh():
    m, events, run_dir = run_scenario('px4_s0_healthy', 'pact_quorum', timeout=1200,
                                      backend='px4', extra=['radio:=mesh'])
    assert m['jobs_eligible'] >= 4, run_dir
    assert m['on_time_rate'] >= 0.8, (m['on_time_rate'], run_dir)
    assert m['invariants']['ok'], (m['invariants'], run_dir)
    # Every frame on the wire was authenticated: nothing was rejected without an attacker.
    assert not of_type(events, 'RADIO_AUTH_REJECT'), run_dir
    # The fleet saw itself over the bridges (all members reachable at some point).
    status = of_type(events, 'STATUS')
    assert status and max(e['data']['reachable'] for e in status) >= 6, run_dir
