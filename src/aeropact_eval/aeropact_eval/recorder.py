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
Event recorder.

Writes every FleetEvent to <run_dir>/events.jsonl as it arrives (streaming, no
buffering of the run in memory), samples coordinator status digests for convergence analysis,
and ends the run at `duration_s` of simulation time by computing metrics.json and exiting.
"""

import json
import os
import sys

from aeropact_eval import eventlog
from aeropact_eval import metrics as metrics_mod
from aeropact_interfaces.msg import CoordinatorStatus, FleetEvent
import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy


class EventRecorder(Node):

    def __init__(self):
        super().__init__('event_recorder')
        self.declare_parameter('run_dir', '/tmp/aeropact_run')
        self.declare_parameter('duration_s', 0.0)
        self.declare_parameter('drone_ids', [''])
        self.declare_parameter('status_period_s', 5.0)
        self.run_dir = self.get_parameter('run_dir').value
        self.duration = float(self.get_parameter('duration_s').value)
        os.makedirs(self.run_dir, exist_ok=True)
        self.out = open(os.path.join(self.run_dir, 'events.jsonl'), 'a', encoding='utf-8',
                        buffering=1)
        self.count = 0
        self.done = False
        qos = QoSProfile(depth=2000, reliability=ReliabilityPolicy.RELIABLE,
                         durability=DurabilityPolicy.VOLATILE)
        self.create_subscription(FleetEvent, '/fleet/events', self.on_event, qos)
        self.last_status = {}
        for drone in [d for d in self.get_parameter('drone_ids').value if d]:
            self.create_subscription(CoordinatorStatus, '/%s/status' % drone, self.on_status, 10)
        self.create_timer(1.0, self.check_end)
        self.get_logger().info('recording to %s (duration %.0fs)' % (self.run_dir, self.duration))

    def on_event(self, msg: FleetEvent):
        t = msg.stamp.sec + msg.stamp.nanosec * 1e-9
        try:
            data = json.loads(msg.data) if msg.data else {}
        except json.JSONDecodeError:
            data = {'raw': msg.data}
        self.out.write(eventlog.dump_line(t, msg.agent, msg.type, data) + '\n')
        self.count += 1

    def on_status(self, msg: CoordinatorStatus):
        t = msg.header.stamp.sec + msg.header.stamp.nanosec * 1e-9
        period = float(self.get_parameter('status_period_s').value)
        if t - self.last_status.get(msg.drone_id, -1e9) < period:
            return
        self.last_status[msg.drone_id] = t
        self.out.write(eventlog.dump_line(t, msg.drone_id, 'STATUS', {
            'digest': str(msg.task_digest), 'tasks': msg.replica_tasks, 'mode': msg.mode,
            'activity': msg.activity, 'reachable': msg.reachable_members,
            'known': msg.known_members, 'tx': msg.frames_sent, 'rx': msg.frames_received,
            'bundle': list(msg.bundle)}) + '\n')

    def check_end(self):
        now = self.get_clock().now().nanoseconds * 1e-9
        if self.done or self.duration <= 0.0 or now < self.duration:
            return
        self.done = True
        self.out.flush()
        m = metrics_mod.compute_run(self.run_dir, end_time=self.duration)
        with open(os.path.join(self.run_dir, 'metrics.json'), 'w', encoding='utf-8') as f:
            json.dump(m, f, indent=2, sort_keys=True)
        self.get_logger().info(
            'run complete at t=%.0f: %d events, on-time %s, duplicates %d, invariants %s'
            % (now, self.count, m['on_time_rate'], m['duplicate_deliveries'],
               'OK' if m['invariants']['ok'] else 'VIOLATED'))
        raise SystemExit(0)

    def close(self):
        self.out.close()


def main(args=None):
    rclpy.init(args=args)
    node = EventRecorder()
    code = 0
    try:
        rclpy.spin(node)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        node.close()
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return code


if __name__ == '__main__':
    sys.exit(main())
