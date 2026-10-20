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
"""
Pure-Python test suite: runs on plain Python 3.10+ without ROS 2, colcon or Gazebo.

Puts the ROS-free modules on sys.path: the `aeropact_eval` package (eventlog, metrics,
invariants, bench helpers - only recorder.py and monitor.py need rclpy, and nothing here imports
them) and the world generator script of `aeropact_sim`.
"""

import os
import sys

from hypothesis import settings

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
for p in (os.path.join(ROOT, 'src', 'aeropact_eval'),
          os.path.join(ROOT, 'src', 'aeropact_sim', 'scripts')):
    if p not in sys.path:
        sys.path.insert(0, p)

settings.register_profile('ci', max_examples=300, deadline=None)
settings.register_profile('dev', max_examples=100, deadline=None)
settings.load_profile(os.environ.get('HYPOTHESIS_PROFILE', 'dev'))
