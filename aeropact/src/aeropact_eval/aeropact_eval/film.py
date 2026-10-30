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
Film director: records a run to video from the film camera (scenario.launch.py film:=<shots.yaml>).

Gazebo renders the `film_camera` sensor server-side in simulation time; this node moves it along
the shot list through the bridged /world/<name>/set_pose service once per frame, and pipes every
frame inside the recording window into ffmpeg. A sidecar `<output>.frames.csv` maps each frame to
its simulation time, so captions can be aligned with events.jsonl in post-production.

Observation only: it never publishes on fleet topics.
"""

import os
import shutil
import subprocess

from aeropact_eval.shots import look_at_quaternion, ShotList
from nav_msgs.msg import Odometry
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from ros_gz_interfaces.msg import Entity
from ros_gz_interfaces.srv import SetEntityPose
from sensor_msgs.msg import Image


class FilmDirector(Node):

    def __init__(self):
        super().__init__('film_director')
        self.declare_parameter('shots', '')
        self.declare_parameter('output', '')
        self.declare_parameter('world', 'map')
        self.declare_parameter('fps', 25)
        self.declare_parameter('ffmpeg', 'ffmpeg')
        self.declare_parameter('codec', '')
        self.declare_parameter('odom_topic', 'odom')
        self.shots = ShotList.load(self.get_parameter('shots').value)
        self.output = os.path.expanduser(self.get_parameter('output').value)
        self.fps = int(self.get_parameter('fps').value)
        self.positions = {}
        for did in self.shots.drones():
            self.create_subscription(
                Odometry, '/%s/%s' % (did, self.get_parameter('odom_topic').value),
                lambda m, d=did: self._on_odom(d, m), qos_profile_sensor_data)
        world = self.get_parameter('world').value
        self.set_pose = self.create_client(SetEntityPose, '/world/%s/set_pose' % world)
        self.pending = None
        self.create_subscription(Image, '/film/image', self._on_frame, 10)
        self.timer = self.create_timer(1.0 / self.fps, self._move)  # simulation time
        self.ffmpeg = None
        self.frames = 0
        self.index = None
        self.done = False
        self.get_logger().info(
            'film: %.0f-%.0f s -> %s' % (self.shots.start_s, self.shots.end_s, self.output))

    def _on_odom(self, did, m):
        p = m.pose.pose.position
        self.positions[did] = [p.x, p.y, p.z]

    def _now(self):
        return self.get_clock().now().nanoseconds * 1e-9

    def _move(self):
        if self.done or (self.pending is not None and not self.pending.done()):
            return
        if not self.set_pose.service_is_ready():
            return
        k = self.shots.resolve(self._now(), self.positions)
        if k is None:
            return
        eye, look = k
        q = look_at_quaternion(eye, look)
        req = SetEntityPose.Request()
        req.entity.name = 'film_camera'
        req.entity.type = Entity.MODEL
        req.pose.position.x, req.pose.position.y, req.pose.position.z = eye
        (req.pose.orientation.x, req.pose.orientation.y, req.pose.orientation.z,
         req.pose.orientation.w) = q
        self.pending = self.set_pose.call_async(req)

    def _open(self, w, h):
        exe = self.get_parameter('ffmpeg').value
        codec = self.get_parameter('codec').value or (
            'h264_nvenc' if exe.endswith('.exe') else 'libx264')
        out = self.output
        if exe.endswith('.exe') and out.startswith('/mnt/'):
            # a Windows ffmpeg needs a Windows path: /mnt/c/x -> C:\x
            out = out[5].upper() + ':\\' + out[7:].replace('/', '\\')
        os.makedirs(os.path.dirname(self.output) or '.', exist_ok=True)
        quality = ['-cq', '19', '-preset', 'p5'] if 'nvenc' in codec else ['-crf', '18']
        cmd = [exe, '-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo',
               '-pix_fmt', 'rgb24', '-s', '%dx%d' % (w, h), '-r', str(self.fps), '-i', '-',
               '-c:v', codec] + quality + ['-pix_fmt', 'yuv420p', out]
        if shutil.which(exe) is None and not os.path.isfile(exe):
            raise RuntimeError('ffmpeg not found: %s' % exe)
        self.ffmpeg = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        self.index = open(self.output + '.frames.csv', 'w', encoding='utf-8')
        self.index.write('frame,sim_time_s\n')

    def _on_frame(self, m):
        if self.done:
            return
        t = m.header.stamp.sec + m.header.stamp.nanosec * 1e-9
        if t < self.shots.start_s:
            return
        if t > self.shots.end_s:
            self._finish()
            return
        if m.encoding not in ('rgb8', 'bgr8'):
            self.get_logger().warning('unexpected image encoding %s' % m.encoding)
            return
        if self.ffmpeg is None:
            self._open(m.width, m.height)
        data = bytes(m.data)
        if m.encoding == 'bgr8':
            b = bytearray(data)
            b[0::3], b[2::3] = data[2::3], data[0::3]
            data = bytes(b)
        self.ffmpeg.stdin.write(data)
        self.index.write('%d,%.3f\n' % (self.frames, t))
        self.frames += 1

    def _finish(self):
        if self.done:
            return
        self.done = True
        if self.ffmpeg is not None:
            self.ffmpeg.stdin.close()
            self.ffmpeg.wait()
            self.index.close()
        self.get_logger().info('film: %d frames (%.1f s of video) -> %s'
                               % (self.frames, self.frames / float(self.fps), self.output))


def main():
    rclpy.init()
    node = FilmDirector()
    try:
        while rclpy.ok() and not node.done:
            rclpy.spin_once(node, timeout_sec=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        node._finish()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == '__main__':
    main()
