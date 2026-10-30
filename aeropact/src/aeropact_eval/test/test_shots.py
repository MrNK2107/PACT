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
"""Film-mode shot lists: interpolation, drone following and the camera orientation."""

import math

from aeropact_eval.shots import look_at_quaternion, ShotList
import pytest


def rotate(q, v):
    x, y, z, w = q
    # v' = q v q*, written out
    ux, uy, uz = v
    tx = 2 * (y * uz - z * uy)
    ty = 2 * (z * ux - x * uz)
    tz = 2 * (x * uy - y * ux)
    return (ux + w * tx + (y * tz - z * ty), uy + w * ty + (z * tx - x * tz),
            uz + w * tz + (x * ty - y * tx))


@pytest.mark.parametrize('eye,look', [
    ((0, 0, 100), (50, 0, 0)), ((10, -20, 60), (-40, 30, 5)), ((0, 0, 10), (0, 1, 10)),
    ((5, 5, 400), (0, 0, 0))])
def test_camera_x_axis_points_at_the_target(eye, look):
    q = look_at_quaternion(eye, look)
    assert math.isclose(sum(c * c for c in q), 1.0, rel_tol=1e-9)
    d = [look[i] - eye[i] for i in range(3)]
    n = math.sqrt(sum(c * c for c in d))
    fwd = rotate(q, (1.0, 0.0, 0.0))
    assert all(math.isclose(fwd[i], d[i] / n, abs_tol=1e-9) for i in range(3))
    up = rotate(q, (0.0, 0.0, 1.0))
    assert up[2] >= -1e-9  # no roll: the camera's up never points below the horizon


def test_keyframes_ease_between_and_hold_at_the_ends():
    s = ShotList({'shots': [{'t': 10, 'eye': [0, 0, 100], 'look': [0, 0, 0]},
                            {'t': 20, 'eye': [100, 0, 100], 'look': [10, 0, 0]}]})
    assert s.start_s == 10 and s.end_s == 20
    assert s.resolve(0, {})[0] == [0, 0, 100]
    assert s.resolve(30, {})[0] == [100, 0, 100]
    mid = s.resolve(15, {})
    assert mid[0] == [50, 0, 100] and mid[1] == [5, 0, 0]
    # smoothstep: slow near the keyframes
    assert s.resolve(11, {})[0][0] < 10


def test_follow_tracks_the_drone_and_waits_for_its_position():
    s = ShotList({'start_s': 0, 'end_s': 100, 'shots': [
        {'t': 0, 'eye': [0, 0, 200], 'look': [0, 0, 0]},
        {'t': 10, 'follow': 'A01', 'offset': [-30, 0, 20]}]})
    assert s.drones() == ['A01']
    assert s.resolve(5, {})[0] == [0, 0, 200]  # no odometry yet: hold the fixed keyframe
    eye, look = s.resolve(50, {'A01': [100, 40, 30]})
    assert look == [100, 40, 30] and eye == [70, 40, 50]


@pytest.mark.parametrize('doc', [{}, {'shots': [{'t': 0, 'eye': [0, 0, 1]}]},
                                 {'start_s': 5, 'end_s': 5, 'shots': [{'t': 0, 'follow': 'A1'}]}])
def test_invalid_shot_lists_are_rejected(doc):
    with pytest.raises(ValueError):
        ShotList(doc)
