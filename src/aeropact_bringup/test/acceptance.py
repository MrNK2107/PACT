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
"""Helpers for the scenario acceptance tests: run a scenario headless and load its results."""

import json
import os
import subprocess
import tempfile

from aeropact_eval import eventlog

TIME_SCALE = float(os.environ.get('AEROPACT_TIME_SCALE', '3.0'))


def run_scenario(scenario, system=None, timeout=1200, backend='kinematic', extra=()):
    """
    Launch the full stack headless; returns (metrics, events, run_dir).

    The kinematic backend runs faster than real time with all vehicles in one container; the px4
    backend (PX4 SITL autopilots) runs at real time with one companion container per vehicle.
    """
    run_dir = tempfile.mkdtemp(prefix='aeropact_%s_%s_' % (scenario, system or 'default'))
    cmd = ['ros2', 'launch', 'aeropact_bringup', 'scenario.launch.py',
           'scenario:=%s' % scenario, 'backend:=%s' % backend, 'run_dir:=%s' % run_dir]
    if backend == 'kinematic':
        cmd += ['time_scale:=%s' % TIME_SCALE, 'drone_isolation:=shared']
    cmd += list(extra)
    if system:
        cmd.append('system:=%s' % system)
    env = dict(os.environ)
    env.setdefault('ROS_DOMAIN_ID', '77')
    with open(os.path.join(run_dir, 'launch.log'), 'w', encoding='utf-8') as log:
        subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, env=env,
                       check=False)
    metrics_path = os.path.join(run_dir, 'metrics.json')
    assert os.path.exists(metrics_path), 'run did not complete, see %s/launch.log' % run_dir
    with open(metrics_path, encoding='utf-8') as f:
        metrics = json.load(f)
    events = eventlog.load(os.path.join(run_dir, 'events.jsonl'))
    return metrics, events, run_dir


def of_type(events, *types):
    return eventlog.of_type(events, *types)
