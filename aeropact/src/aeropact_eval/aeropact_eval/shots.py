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
Shot lists for film mode (ROS-free, so it is unit-testable anywhere).

A shot list is a YAML document with a recording window and keyframes in simulation time:

    start_s: 60          # first recorded frame
    end_s: 420           # last recorded frame
    shots:
      - {t: 60, eye: [-600, -500, 260], look: [0, 0, 0]}   # fixed camera
      - {t: 75, eye: [-300, -250, 140], look: [0, 0, 20]}  # eased move to here by t = 75
      - {t: 90, follow: A01, offset: [-35, -35, 22]}       # follow a drone from t = 90
      - {t: 120, eye: [0, -900, 500], look: [0, 0, 0]}

Between keyframes the eye and the look-at point ease (smoothstep) from one to the next; a `follow`
keyframe resolves to the drone's position (look) and position + offset (eye) every frame, so a
cut onto a drone is a smooth move that ends locked onto it.
"""

import math

import yaml


def smoothstep(u):
    u = min(1.0, max(0.0, u))
    return u * u * (3.0 - 2.0 * u)


def lerp(a, b, k):
    return [a[i] + (b[i] - a[i]) * k for i in range(3)]


def look_at_quaternion(eye, look):
    """
    Orientation (x, y, z, w) of a Gazebo camera at `eye` looking at `look`.

    Gazebo cameras look along their +X axis with +Z up, so this is yaw about Z then pitch about
    the new Y (positive pitch points the nose down), with no roll.
    """
    dx, dy, dz = (look[0] - eye[0], look[1] - eye[1], look[2] - eye[2])
    yaw = math.atan2(dy, dx)
    pitch = math.atan2(-dz, math.hypot(dx, dy))
    cy, sy = math.cos(yaw / 2), math.sin(yaw / 2)
    cp, sp = math.cos(pitch / 2), math.sin(pitch / 2)
    # q = q_yaw(z) * q_pitch(y)
    return (-sy * sp, cy * sp, sy * cp, cy * cp)


class ShotList:
    """Keyframed camera path. `resolve(t, positions)` gives (eye, look) at simulation time t."""

    def __init__(self, doc):
        shots = sorted(doc.get('shots') or [], key=lambda s: float(s['t']))
        if not shots:
            raise ValueError('a shot list needs at least one shot')
        for s in shots:
            if 'follow' not in s and ('eye' not in s or 'look' not in s):
                raise ValueError('shot at t=%s needs eye + look, or follow' % s.get('t'))
        self.shots = shots
        self.start_s = float(doc.get('start_s', shots[0]['t']))
        self.end_s = float(doc.get('end_s', shots[-1]['t']))
        if self.end_s <= self.start_s:
            raise ValueError('end_s must be after start_s')

    @classmethod
    def load(cls, path):
        with open(path, encoding='utf-8') as f:
            return cls(yaml.safe_load(f) or {})

    def drones(self):
        return sorted({s['follow'] for s in self.shots if 'follow' in s})

    @staticmethod
    def _keyframe(shot, positions):
        if 'follow' in shot:
            p = positions.get(shot['follow'])
            if p is None:
                return None
            off = shot.get('offset', [-30.0, -30.0, 20.0])
            return [p[i] + off[i] for i in range(3)], list(p)
        return [float(v) for v in shot['eye']], [float(v) for v in shot['look']]

    def resolve(self, t, positions):
        """Eye and look-at point at time t; `positions` maps drone id to [x, y, z]."""
        shots = self.shots
        if t <= float(shots[0]['t']):
            k = self._keyframe(shots[0], positions)
            return k
        for a, b in zip(shots, shots[1:]):
            ta, tb = float(a['t']), float(b['t'])
            if t <= tb:
                ka = self._keyframe(a, positions)
                kb = self._keyframe(b, positions)
                if ka is None or kb is None:
                    return ka or kb
                k = smoothstep((t - ta) / (tb - ta)) if tb > ta else 1.0
                return lerp(ka[0], kb[0], k), lerp(ka[1], kb[1], k)
        return self._keyframe(shots[-1], positions)
