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
"""AT-03: a 5-minute partition with STRICT produces no duplicate delivery (I1)."""

from acceptance import of_type, run_scenario


def test_split_brain_strict():
    m, events, run_dir = run_scenario('at03_split_brain', 'pact_strict')
    partition_jobs = [e for e in of_type(events, 'TASK_CREATED') if 80 <= e['t'] <= 380]
    assert len(partition_jobs) >= 12, (len(partition_jobs), run_dir)
    assert m['duplicate_deliveries'] == 0, run_dir
    assert m['duplicate_dispatches'] == 0, run_dir
    assert not m['invariants']['I1'], m['invariants']['I1']
    assert m['jobs_delivered'] >= 10, (m['jobs_delivered'], run_dir)
