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
"""Healthy operations: jobs flow end to end, all invariants hold, message budget respected."""

from acceptance import run_scenario


def test_healthy_operations():
    m, events, run_dir = run_scenario('at_s0_healthy', 'pact_quorum')
    assert m['jobs_eligible'] >= 4, run_dir
    assert m['on_time_rate'] >= 0.8, (m['on_time_rate'], run_dir)
    assert m['invariants']['ok'], (m['invariants'], run_dir)
    assert m['msgs_per_drone_min'] is not None and m['msgs_per_drone_min'] <= 120, run_dir
