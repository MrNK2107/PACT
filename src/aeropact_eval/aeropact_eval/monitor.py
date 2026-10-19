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
RViz fleet monitor (REQ-VIZ-001).

Drones are coloured by link mode, task drop points coloured by
state with ownership lines, depots and pads, and no-fly zones (red static, orange closable, grey
when inactive). Publishes visualization_msgs/MarkerArray on /aeropact/markers.
"""

import json
import sys

from aeropact_interfaces.msg import (AirspaceRestrictionArray, CoordinatorStatus, FleetEvent,
                                     SafetyStatus)
from geometry_msgs.msg import Point
from nav_msgs.msg import Odometry
import rclpy
from rclpy.node import Node
from rclpy.qos import DurabilityPolicy, QoSProfile, ReliabilityPolicy
from std_msgs.msg import ColorRGBA
from visualization_msgs.msg import Marker, MarkerArray
import yaml

MODE_COLOURS = {0: (0.1, 0.8, 0.2), 1: (0.95, 0.8, 0.1), 2: (0.95, 0.4, 0.05), 3: (0.85, 0.1, 0.1)}
STATE_COLOURS = {'UNASSIGNED': (0.7, 0.7, 0.7), 'CLAIMED': (0.4, 0.6, 1.0),
                 'COMMITTED': (0.1, 0.3, 0.95), 'PICKED_UP': (0.6, 0.1, 0.9),
                 'DELIVERED': (0.1, 0.8, 0.2), 'ABORTED': (0.9, 0.1, 0.1)}


def colour(rgb, a=1.0):
    return ColorRGBA(r=float(rgb[0]), g=float(rgb[1]), b=float(rgb[2]), a=float(a))


class FleetMonitor(Node):

    def __init__(self):
        super().__init__('fleet_monitor')
        self.declare_parameter('world_file', '')
        self.declare_parameter('drone_ids', [''])
        self.declare_parameter('rate_hz', 2.0)
        with open(self.get_parameter('world_file').value, encoding='utf-8') as f:
            self.world = yaml.safe_load(f)['world']
        self.drones = {d: {'pos': None, 'mode': 0, 'activity': 0, 'safety': 0, 'task': ''}
                       for d in self.get_parameter('drone_ids').value if d}
        self.tasks = {}
        self.zones = {z['id']: z for z in self.world.get('no_fly', [])}
        for d in self.drones:
            self.create_subscription(Odometry, '/%s/odom' % d,
                                     lambda m, d=d: self.on_odom(d, m), 5)
            self.create_subscription(CoordinatorStatus, '/%s/status' % d,
                                     lambda m, d=d: self.on_status(d, m), 5)
            self.create_subscription(SafetyStatus, '/%s/safety/status' % d,
                                     lambda m, d=d: self.on_safety(d, m), 5)
        rel = QoSProfile(depth=1000, reliability=ReliabilityPolicy.RELIABLE)
        self.create_subscription(FleetEvent, '/fleet/events', self.on_event, rel)
        latched = QoSProfile(depth=1, reliability=ReliabilityPolicy.RELIABLE,
                             durability=DurabilityPolicy.TRANSIENT_LOCAL)
        self.create_subscription(AirspaceRestrictionArray, '/airspace/restrictions',
                                 self.on_airspace, latched)
        self.pub = self.create_publisher(MarkerArray, '/aeropact/markers', latched)
        self.create_timer(1.0 / float(self.get_parameter('rate_hz').value), self.publish)

    def on_odom(self, d, m):
        p = m.pose.pose.position
        self.drones[d]['pos'] = (p.x, p.y, p.z)

    def on_status(self, d, m):
        self.drones[d]['mode'] = m.mode
        self.drones[d]['activity'] = m.activity
        self.drones[d]['task'] = m.current_task

    def on_safety(self, d, m):
        self.drones[d]['safety'] = m.action

    def on_airspace(self, m):
        for r in m.restrictions:
            self.zones[r.id] = {'id': r.id, 'polygon': [[p.x, p.y] for p in r.polygon],
                                'active': r.active, 'dynamic': True}

    def on_event(self, m):
        try:
            d = json.loads(m.data)
        except json.JSONDecodeError:
            return
        tid = d.get('task_id')
        if m.type == 'TASK_CREATED':
            self.tasks[tid] = {'drop': (d['drop_x'], d['drop_y']), 'state': 'UNASSIGNED',
                               'owner': '', 'priority': d.get('priority', 3)}
        elif tid in self.tasks:
            state = {'CLAIM': 'CLAIMED', 'COMMIT': 'COMMITTED', 'PICKED_UP': 'PICKED_UP',
                     'DELIVERED': 'DELIVERED', 'TASK_ABORTED': 'ABORTED',
                     'RELEASE': 'UNASSIGNED', 'LEASE_EXPIRED_REOPEN': 'UNASSIGNED'}.get(m.type)
            if state:
                self.tasks[tid]['state'] = state
                self.tasks[tid]['owner'] = m.agent if state not in ('UNASSIGNED',) else ''

    def marker(self, ns, mid, mtype, rgb, a=1.0):
        mk = Marker()
        mk.header.frame_id = 'map'
        mk.header.stamp = self.get_clock().now().to_msg()
        mk.ns = ns
        mk.id = mid
        mk.type = mtype
        mk.action = Marker.ADD
        mk.color = colour(rgb, a)
        mk.pose.orientation.w = 1.0
        return mk

    def publish(self):
        arr = MarkerArray()
        mid = 0
        for depot in self.world['depots']:
            mk = self.marker('depots', mid, Marker.CUBE, (0.8, 0.55, 0.3))
            mk.pose.position.x, mk.pose.position.y = depot['position'][0], depot['position'][1]
            mk.pose.position.z = 5.0
            mk.scale.x, mk.scale.y, mk.scale.z = 30.0, 20.0, 10.0
            arr.markers.append(mk)
            mid += 1
            for pad in depot['pads']:
                mk = self.marker('pads', mid, Marker.CYLINDER, (0.1, 0.6, 0.25))
                mk.pose.position.x, mk.pose.position.y = pad['position'][0], pad['position'][1]
                mk.scale.x = mk.scale.y = 3.0
                mk.scale.z = 0.2
                arr.markers.append(mk)
                mid += 1
        for z in self.zones.values():
            active = z.get('active', True)
            if not active:
                rgb = (0.6, 0.6, 0.6)
            elif z.get('dynamic'):
                rgb = (1.0, 0.5, 0.0)
            else:
                rgb = (1.0, 0.1, 0.1)
            mk = self.marker('no_fly', mid, Marker.LINE_STRIP, rgb)
            mk.scale.x = 2.0
            pts = z['polygon'] + [z['polygon'][0]]
            mk.points = [Point(x=float(p[0]), y=float(p[1]), z=1.0) for p in pts]
            arr.markers.append(mk)
            mid += 1
        for tid, t in self.tasks.items():
            if t['state'] == 'DELIVERED':
                continue
            rgb = STATE_COLOURS.get(t['state'], (1, 1, 1))
            mk = self.marker('tasks', mid, Marker.CYLINDER, rgb)
            mk.pose.position.x, mk.pose.position.y = t['drop']
            mk.pose.position.z = 1.0
            mk.scale.x = mk.scale.y = 6.0 if t['priority'] == 1 else 4.0
            mk.scale.z = 2.0
            arr.markers.append(mk)
            mid += 1
            owner = self.drones.get(t['owner'])
            if owner and owner['pos'] and t['state'] in ('CLAIMED', 'COMMITTED', 'PICKED_UP'):
                ln = self.marker('ownership', mid, Marker.LINE_LIST, rgb, 0.6)
                ln.scale.x = 0.8
                ln.points = [Point(x=owner['pos'][0], y=owner['pos'][1], z=owner['pos'][2]),
                             Point(x=float(t['drop'][0]), y=float(t['drop'][1]), z=1.0)]
                arr.markers.append(ln)
                mid += 1
        for d, s in sorted(self.drones.items()):
            if not s['pos']:
                continue
            rgb = MODE_COLOURS.get(s['mode'], (1, 1, 1))
            if s['safety'] >= 2:
                rgb = (1.0, 0.0, 1.0)
            mk = self.marker('drones', mid, Marker.SPHERE, rgb)
            mk.pose.position.x, mk.pose.position.y, mk.pose.position.z = s['pos']
            mk.scale.x = mk.scale.y = mk.scale.z = 8.0
            arr.markers.append(mk)
            mid += 1
            tx = self.marker('labels', mid, Marker.TEXT_VIEW_FACING, (1, 1, 1))
            tx.pose.position.x, tx.pose.position.y = s['pos'][0], s['pos'][1]
            tx.pose.position.z = s['pos'][2] + 10.0
            tx.scale.z = 7.0
            tx.text = d
            arr.markers.append(tx)
            mid += 1
        self.pub.publish(arr)


def main(args=None):
    rclpy.init(args=args)
    node = FleetMonitor()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
