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

#include "aeropact_core/replica.hpp"

#include <functional>
#include <utility>

#include "aeropact_core/merge.hpp"

namespace aeropact::core
{
namespace
{

bool lease_identity_changed(const Task & a, const Task & b)
{
  return a.claim_epoch != b.claim_epoch || a.lease_seq != b.lease_seq || a.owner != b.owner ||
         a.state != b.state;
}

std::uint64_t mix(std::uint64_t h, std::uint64_t v)
{
  // splitmix64 step: order-sensitive, well distributed
  h ^= v + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2);
  return h;
}

}  // namespace

FleetReplica::FleetReplica(ReplicaConfig config)
: config_(config) {}

std::uint64_t FleetReplica::bump()
{
  return ++version_;
}

std::optional<TaskTransition> FleetReplica::upsert_task(const Task & t, double now_local)
{
  if (t.task_id.empty() || is_tombstoned(t.task_id)) {
    return std::nullopt;
  }
  auto it = tasks_.find(t.task_id);
  if (it == tasks_.end()) {
    TaskEntry e;
    e.task = t;
    e.task.epoch = std::max(t.epoch, t.claim_epoch);
    e.changed_at = bump();
    e.observed_local = now_local;
    e.terminal_since = is_terminal(t.state) ? now_local : -1.0;
    auto inserted = tasks_.emplace(t.task_id, std::move(e)).first;
    return TaskTransition{std::nullopt, inserted->second.task};
  }
  TaskEntry & e = it->second;
  Task merged = merge_task(e.task, t);
  if (merged == e.task) {
    return std::nullopt;
  }
  TaskTransition tr{e.task, merged};
  if (lease_identity_changed(e.task, merged)) {
    e.observed_local = now_local;
  }
  if (is_terminal(merged.state) && e.terminal_since < 0.0) {
    e.terminal_since = now_local;
  }
  e.task = std::move(merged);
  e.changed_at = bump();
  return tr;
}

bool FleetReplica::upsert_drone(const DroneInfo & d)
{
  if (d.drone_id.empty()) {
    return false;
  }
  auto it = drones_.find(d.drone_id);
  if (it != drones_.end() && !drone_newer(d, it->second)) {
    return false;
  }
  drones_[d.drone_id] = d;
  drone_changed_at_[d.drone_id] = bump();
  return true;
}

bool FleetReplica::add_pad_reservation(const PadReservation & r)
{
  if (r.tag.empty() || pad_adds_.count(r.tag) != 0U) {
    return false;
  }
  pad_adds_[r.tag] = r;
  pad_add_changed_at_[r.tag] = bump();
  return true;
}

bool FleetReplica::remove_pad_reservation(const std::string & tag)
{
  if (tag.empty() || pad_removes_.count(tag) != 0U) {
    return false;
  }
  pad_removes_[tag] = bump();
  return true;
}

std::optional<ShardLease> FleetReplica::upsert_shard_lease(const ShardLease & l)
{
  if (l.shard_id.empty()) {
    return std::nullopt;
  }
  auto it = shard_leases_.find(l.shard_id);
  if (it != shard_leases_.end() && compare_shard_leases(l, it->second) <= 0) {
    return std::nullopt;
  }
  shard_leases_[l.shard_id] = l;
  shard_changed_at_[l.shard_id] = bump();
  return l;
}

MergeResult FleetReplica::apply(const Delta & delta, double now_local)
{
  MergeResult r;
  for (const auto & t : delta.tasks) {
    if (auto tr = upsert_task(t, now_local)) {
      r.tasks.push_back(std::move(*tr));
    }
  }
  for (const auto & d : delta.drones) {
    r.drones_changed = upsert_drone(d) || r.drones_changed;
  }
  for (const auto & p : delta.pad_adds) {
    r.pads_changed = add_pad_reservation(p) || r.pads_changed;
  }
  for (const auto & tag : delta.pad_removes) {
    r.pads_changed = remove_pad_reservation(tag) || r.pads_changed;
  }
  for (const auto & l : delta.shard_leases) {
    if (auto changed = upsert_shard_lease(l)) {
      r.shard_changes.push_back(*changed);
    }
  }
  return r;
}

Delta FleetReplica::delta_since(std::uint64_t since) const
{
  Delta d;
  d.version = version_;
  for (const auto & [id, e] : tasks_) {
    if (e.changed_at > since) {
      d.tasks.push_back(e.task);
    }
  }
  for (const auto & [id, v] : drone_changed_at_) {
    if (v > since) {
      d.drones.push_back(drones_.at(id));
    }
  }
  for (const auto & [tag, v] : pad_add_changed_at_) {
    if (v > since) {
      d.pad_adds.push_back(pad_adds_.at(tag));
    }
  }
  for (const auto & [tag, v] : pad_removes_) {
    if (v > since) {
      d.pad_removes.push_back(tag);
    }
  }
  for (const auto & [id, v] : shard_changed_at_) {
    if (v > since) {
      d.shard_leases.push_back(shard_leases_.at(id));
    }
  }
  return d;
}

Delta FleetReplica::full_state() const
{
  Delta d = delta_since(0);
  d.full_sync = true;
  return d;
}

const Task * FleetReplica::task(const std::string & id) const
{
  auto it = tasks_.find(id);
  return it == tasks_.end() ? nullptr : &it->second.task;
}

const FleetReplica::TaskEntry * FleetReplica::task_entry(const std::string & id) const
{
  auto it = tasks_.find(id);
  return it == tasks_.end() ? nullptr : &it->second;
}

const DroneInfo * FleetReplica::drone(const std::string & id) const
{
  auto it = drones_.find(id);
  return it == drones_.end() ? nullptr : &it->second;
}

const ShardLease * FleetReplica::shard_lease(const std::string & shard_id) const
{
  auto it = shard_leases_.find(shard_id);
  return it == shard_leases_.end() ? nullptr : &it->second;
}

std::vector<PadReservation> FleetReplica::pad_reservations() const
{
  std::vector<PadReservation> out;
  for (const auto & [tag, r] : pad_adds_) {
    if (pad_removes_.count(tag) == 0U) {
      out.push_back(r);
    }
  }
  return out;
}

bool FleetReplica::is_tombstoned(const std::string & task_id) const
{
  return tombstones_.count(task_id) != 0U;
}

std::size_t FleetReplica::prune(double now_local)
{
  std::size_t removed = 0;
  for (auto it = tasks_.begin(); it != tasks_.end(); ) {
    const TaskEntry & e = it->second;
    if (e.terminal_since >= 0.0 && now_local - e.terminal_since > config_.terminal_retention_s) {
      tombstones_[it->first] = now_local;
      it = tasks_.erase(it);
      ++removed;
    } else {
      ++it;
    }
  }
  for (auto it = tombstones_.begin(); it != tombstones_.end(); ) {
    if (now_local - it->second > config_.tombstone_retention_s) {
      it = tombstones_.erase(it);
    } else {
      ++it;
    }
  }
  // Removed OR-set tags whose add is known can be compacted together with the add.
  for (auto it = pad_removes_.begin(); it != pad_removes_.end(); ) {
    auto add = pad_adds_.find(it->first);
    if (add != pad_adds_.end() &&
      now_local - add->second.window_end > config_.terminal_retention_s)
    {
      pad_add_changed_at_.erase(add->first);
      pad_adds_.erase(add);
      it = pad_removes_.erase(it);
    } else {
      ++it;
    }
  }
  if (removed > 0) {
    bump();
  }
  return removed;
}

std::uint64_t FleetReplica::task_digest() const
{
  std::uint64_t h = 1469598103934665603ULL;
  const std::hash<std::string> hs;
  for (const auto & [id, e] : tasks_) {
    const Task & t = e.task;
    h = mix(h, hs(id));
    h = mix(h, static_cast<std::uint64_t>(t.state));
    h = mix(h, t.epoch);
    h = mix(h, t.claim_epoch);
    h = mix(h, hs(t.owner));
    h = mix(h, std::hash<double>{}(t.bid));
  }
  return h;
}

}  // namespace aeropact::core
