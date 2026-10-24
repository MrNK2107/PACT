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
"""PX4 SITL: healthy operations with real autopilots in the loop (backend px4)."""

import glob
import os

from acceptance import of_type, run_scenario


def test_px4_healthy_operations():
    m, events, run_dir = run_scenario('px4_s0_healthy', 'pact_quorum', timeout=1200,
                                      backend='px4')
    assert m['jobs_eligible'] >= 4, run_dir
    assert m['on_time_rate'] >= 0.8, (m['on_time_rate'], run_dir)
    assert m['invariants']['ok'], (m['invariants'], run_dir)
    assert m['collisions'] == 0 and m['nfz_violations'] == 0, run_dir
    # Every vehicle that was asked to fly went through the arbiter into OFFBOARD under its own
    # autopilot, and the autopilots never took over.
    armed = {e['agent'] for e in of_type(events, 'ARMED')}
    offboard = {e['agent'] for e in of_type(events, 'AUTOPILOT_LINK')
                if e['data']['to'] == 'OFFBOARD'}
    assert armed and armed <= offboard, (armed, offboard, run_dir)
    assert not [e for e in of_type(events, 'AUTOPILOT_LINK')
                if e['data']['to'] == 'AUTOPILOT_OVERRIDE'], run_dir
    # Every delivery released its parcel through the autopilot's payload module (DO_GRIPPER),
    # and the autopilot acknowledged each actuation.
    releases = [e for e in of_type(events, 'PAYLOAD_ACTUATED') if e['data']['action'] == 'release']
    assert len(releases) >= len(of_type(events, 'DELIVERED')), run_dir
    assert not of_type(events, 'PAYLOAD_FAULT'), run_dir
    # The autopilots logged their flights.
    assert glob.glob(os.path.join(run_dir, 'px4', '*', 'log', '*', '*.ulg')), run_dir
