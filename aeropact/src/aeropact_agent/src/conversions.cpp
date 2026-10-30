// Copyright 2026 AeroPACT Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "aeropact_agent/conversions.hpp"

namespace aeropact::agent
{

geometry_msgs::msg::Point to_point(const core::Vec3 & v)
{
  geometry_msgs::msg::Point p;
  p.x = v.x;
  p.y = v.y;
  p.z = v.z;
  return p;
}

geometry_msgs::msg::Vector3 to_vector3(const core::Vec3 & v)
{
  geometry_msgs::msg::Vector3 p;
  p.x = v.x;
  p.y = v.y;
  p.z = v.z;
  return p;
}

core::Vec3 from_msg(const geometry_msgs::msg::Point & p)
{
  return {p.x, p.y, p.z};
}

core::Vec3 from_msg(const geometry_msgs::msg::Vector3 & v)
{
  return {v.x, v.y, v.z};
}

msg::TaskRecord to_msg(const core::Task & t)
{
  msg::TaskRecord m;
  m.task_id = t.task_id;
  m.origin_depot = t.origin_depot;
  m.pickup = to_point(t.pickup);
  m.drop = to_point(t.drop);
  m.priority = t.priority;
  m.deadline = t.deadline;
  m.weight_kg = t.weight_kg;
  m.shard = t.shard;
  m.state = static_cast<uint8_t>(t.state);
  m.epoch = t.epoch;
  m.claim_epoch = t.claim_epoch;
  m.owner = t.owner;
  m.bid = t.bid;
  m.lease_ttl = t.lease_ttl;
  m.lease_seq = t.lease_seq;
  m.created_at = t.created_at;
  m.replaces = t.replaces;
  m.abort_reason = t.abort_reason;
  return m;
}

core::Task from_msg(const msg::TaskRecord & m)
{
  core::Task t;
  t.task_id = m.task_id;
  t.origin_depot = m.origin_depot;
  t.pickup = from_msg(m.pickup);
  t.drop = from_msg(m.drop);
  t.priority = m.priority;
  t.deadline = m.deadline;
  t.weight_kg = m.weight_kg;
  t.shard = m.shard;
  t.state = m.state <= 5 ? static_cast<core::TaskState>(m.state) : core::TaskState::kUnassigned;
  t.epoch = m.epoch;
  t.claim_epoch = m.claim_epoch;
  t.owner = m.owner;
  t.bid = m.bid;
  t.lease_ttl = m.lease_ttl;
  t.lease_seq = m.lease_seq;
  t.created_at = m.created_at;
  t.replaces = m.replaces;
  t.abort_reason = m.abort_reason;
  return t;
}

msg::DroneState to_msg(const core::DroneInfo & d)
{
  msg::DroneState m;
  m.drone_id = d.drone_id;
  m.seq = d.seq;
  m.position = to_point(d.position);
  m.velocity = to_vector3(d.velocity);
  m.soc = d.soc;
  m.capacity_kg = d.capacity_kg;
  m.health = static_cast<uint8_t>(d.health);
  m.mode = static_cast<uint8_t>(d.mode);
  m.activity = static_cast<uint8_t>(d.activity);
  m.bundle = d.bundle;
  m.known_peers = d.known_peers;
  m.t_local = d.t_local;
  return m;
}

core::DroneInfo from_msg(const msg::DroneState & m)
{
  core::DroneInfo d;
  d.drone_id = m.drone_id;
  d.seq = m.seq;
  d.position = from_msg(m.position);
  d.velocity = from_msg(m.velocity);
  d.soc = m.soc;
  d.capacity_kg = m.capacity_kg;
  d.health = m.health <= 2 ? static_cast<core::Health>(m.health) : core::Health::kOk;
  d.mode = m.mode <= 3 ? static_cast<core::LinkMode>(m.mode) : core::LinkMode::kConnected;
  d.activity = m.activity <= 9 ? static_cast<core::Activity>(m.activity) : core::Activity::kIdle;
  d.bundle = m.bundle;
  d.known_peers = m.known_peers;
  d.t_local = m.t_local;
  return d;
}

msg::PadReservation to_msg(const core::PadReservation & r)
{
  msg::PadReservation m;
  m.tag = r.tag;
  m.pad_id = r.pad_id;
  m.depot_id = r.depot_id;
  m.drone_id = r.drone_id;
  m.window_start = r.window_start;
  m.window_end = r.window_end;
  m.epoch = r.epoch;
  return m;
}

core::PadReservation from_msg(const msg::PadReservation & m)
{
  return {m.tag, m.pad_id, m.depot_id, m.drone_id, m.window_start, m.window_end, m.epoch};
}

msg::ShardLease to_msg(const core::ShardLease & l)
{
  msg::ShardLease m;
  m.shard_id = l.shard_id;
  m.holder = l.holder;
  m.epoch = l.epoch;
  m.lease_seq = l.lease_seq;
  m.lease_ttl = l.lease_ttl;
  return m;
}

core::ShardLease from_msg(const msg::ShardLease & m)
{
  return {m.shard_id, m.holder, m.epoch, m.lease_seq, m.lease_ttl};
}

msg::GossipDelta to_msg(const core::Delta & d)
{
  msg::GossipDelta m;
  m.replica_version = d.version;
  m.full_sync = d.full_sync;
  m.tasks.reserve(d.tasks.size());
  for (const auto & t : d.tasks) {
    m.tasks.push_back(to_msg(t));
  }
  for (const auto & dr : d.drones) {
    m.drones.push_back(to_msg(dr));
  }
  for (const auto & p : d.pad_adds) {
    m.pad_adds.push_back(to_msg(p));
  }
  m.pad_removes = d.pad_removes;
  for (const auto & l : d.shard_leases) {
    m.shard_leases.push_back(to_msg(l));
  }
  return m;
}

core::Delta from_msg(const msg::GossipDelta & m)
{
  core::Delta d;
  d.version = m.replica_version;
  d.full_sync = m.full_sync;
  d.tasks.reserve(m.tasks.size());
  for (const auto & t : m.tasks) {
    d.tasks.push_back(from_msg(t));
  }
  for (const auto & dr : m.drones) {
    d.drones.push_back(from_msg(dr));
  }
  for (const auto & p : m.pad_adds) {
    d.pad_adds.push_back(from_msg(p));
  }
  d.pad_removes = m.pad_removes;
  for (const auto & l : m.shard_leases) {
    d.shard_leases.push_back(from_msg(l));
  }
  return d;
}

}  // namespace aeropact::agent
