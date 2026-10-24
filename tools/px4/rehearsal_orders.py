"""Submit delivery orders to depots through the public SubmitOrder service (site rehearsal).

Usage: python3 rehearsal_orders.py <world.yaml> <n_orders> <interval_s> [use_sim_time]
Orders go round-robin over depots to drop points chosen deterministically from the map.
"""
import sys
import time

import rclpy
from rclpy.node import Node
import yaml

from aeropact_interfaces.srv import SubmitOrder
from geometry_msgs.msg import Point


def main():
    world_file, n, interval = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
    with open(world_file, encoding='utf-8') as f:
        world = yaml.safe_load(f)['world']
    drops = world['drop_points']
    depots = [d['id'] for d in world['depots']]
    rclpy.init()
    node = Node('rehearsal_orders')
    clients = {d: node.create_client(SubmitOrder, '/depots/%s/submit_order' % d) for d in depots}
    for d, c in clients.items():
        if not c.wait_for_service(timeout_sec=60.0):
            print('depot %s: submit_order not available' % d)
            return 1
    accepted = 0
    for k in range(n):
        depot = depots[k % len(depots)]
        drop = drops[(7 * k + 3) % len(drops)]
        req = SubmitOrder.Request()
        req.drop = Point(x=float(drop['position'][0]), y=float(drop['position'][1]),
                         z=float(drop['position'][2]))
        req.drop_id = drop['id']
        req.priority = 2
        req.deadline_offset_s = 600.0
        req.weight_kg = 0.8
        future = clients[depot].call_async(req)
        rclpy.spin_until_future_complete(node, future, timeout_sec=10.0)
        res = future.result()
        ok = res is not None and res.accepted
        accepted += int(ok)
        print('order %d -> %s drop %s: %s %s' % (k, depot, drop['id'], 'accepted' if ok else
                                                 'REJECTED', res.task_id if res else ''))
        time.sleep(interval)
    node.destroy_node()
    rclpy.shutdown()
    return 0 if accepted == n else 2


if __name__ == '__main__':
    sys.exit(main())
