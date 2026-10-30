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
"""PX4 SITL: a 4-minute radio partition (AT-03 with real autopilots): no job delivered twice."""

from acceptance import of_type, run_scenario


def test_px4_split_brain():
    m, events, run_dir = run_scenario('px4_s3_split_brain', 'pact_strict', timeout=1300,
                                      backend='px4')
    assert of_type(events, 'FAULT_INJECTED'), run_dir
    assert m['duplicate_deliveries'] == 0, run_dir
    assert m['invariants']['ok'], (m['invariants'], run_dir)
    assert m['jobs_eligible'] >= 6, run_dir
    assert m['on_time_rate'] >= 0.6, (m['on_time_rate'], run_dir)
    # Both halves kept working through the partition (STRICT holds its shard leases).
    split = [e for e in of_type(events, 'FAULT_INJECTED') if e['data'].get('fault') == 'partition']
    t0 = split[0]['t'] if split else 120.0
    during = {e['agent'] for e in of_type(events, 'DELIVERED') if t0 <= e['t'] <= t0 + 240.0}
    assert during, ('nothing delivered during the partition', run_dir)
    assert not [e for e in of_type(events, 'AUTOPILOT_LINK')
                if e['data']['to'] == 'AUTOPILOT_OVERRIDE'], run_dir
