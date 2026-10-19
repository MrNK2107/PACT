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

#include "aeropact_core/ownership.hpp"

#include <algorithm>
#include <utility>

namespace aeropact::core
{

OwnershipManager::OwnershipManager(std::string self, OwnershipConfig config)
: self_(std::move(self)), config_(config) {}

Task OwnershipManager::claim(const Task & current, double bid, double now_local, bool optimistic)
{
  Task t = current;
  const bool outbid = current.state == TaskState::kClaimed && current.owner != self_;
  if (!outbid) {
    // A fresh claim takes a new fencing token.
    t.claim_epoch = std::max(current.epoch, current.claim_epoch) + 1;
    t.epoch = t.claim_epoch;
  }
  t.state = TaskState::kClaimed;
  t.owner = self_;
  t.bid = bid;
  t.lease_ttl = config_.lease_ttl;
  t.lease_seq = 0;
  t.abort_reason.clear();

  HeldLease h;
  h.task_id = t.task_id;
  h.claim_epoch = t.claim_epoch;
  h.lease_seq = 0;
  h.claimed_local = now_local;
  h.valid_from = now_local;
  h.last_send = now_local;
  h.optimistic = optimistic;
  h.sent_at[0] = now_local;
  held_[t.task_id] = std::move(h);
  return t;
}

void OwnershipManager::adopt(const Task & assigned, double now_local)
{
  HeldLease h;
  h.task_id = assigned.task_id;
  h.claim_epoch = assigned.claim_epoch;
  h.lease_seq = assigned.lease_seq;
  h.claimed_local = now_local;
  h.valid_from = now_local;
  h.last_send = now_local;
  h.confirmed_once = true;
  h.sent_at[assigned.lease_seq] = now_local;
  held_[assigned.task_id] = std::move(h);
}

Task OwnershipManager::commit(const Task & current) const
{
  Task t = current;
  t.state = TaskState::kCommitted;
  return t;
}

Task OwnershipManager::reopen(const Task & current)
{
  Task t = current;
  t.claim_epoch = std::max(current.epoch, current.claim_epoch) + 1;
  t.epoch = t.claim_epoch;
  t.state = TaskState::kUnassigned;
  t.owner.clear();
  t.bid = 0.0;
  t.lease_ttl = 0.0;
  t.lease_seq = 0;
  return t;
}

const OwnershipManager::HeldLease * OwnershipManager::held(const std::string & task_id) const
{
  auto it = held_.find(task_id);
  return it == held_.end() ? nullptr : &it->second;
}

std::size_t OwnershipManager::optimistic_in_flight() const
{
  std::size_t n = 0;
  for (const auto & [id, h] : held_) {
    n += h.optimistic ? 1U : 0U;
  }
  return n;
}

std::vector<Task> OwnershipManager::due_renewals(const FleetReplica & replica, double now_local)
{
  std::vector<Task> out;
  for (auto & [id, h] : held_) {
    if (h.sticky || now_local - h.last_send < config_.renew_period) {
      continue;
    }
    const Task * cur = replica.task(id);
    if (cur == nullptr || cur->owner != self_ || cur->claim_epoch != h.claim_epoch ||
      !is_pre_pickup(cur->state))
    {
      continue;
    }
    Task r = *cur;
    r.lease_seq = std::max(cur->lease_seq, h.lease_seq) + 1;
    h.lease_seq = r.lease_seq;
    h.last_send = now_local;
    h.sent_at[r.lease_seq] = now_local;
    // Keep the pending window bounded.
    while (h.sent_at.size() > 8) {
      h.ackers.erase(h.sent_at.begin()->first);
      h.sent_at.erase(h.sent_at.begin());
    }
    out.push_back(std::move(r));
  }
  return out;
}

void OwnershipManager::on_ack(
  const std::string & acker, const std::string & task_id, std::uint32_t claim_epoch,
  std::uint32_t lease_seq)
{
  auto it = held_.find(task_id);
  if (it == held_.end() || it->second.claim_epoch != claim_epoch) {
    return;
  }
  HeldLease & h = it->second;
  // An ack for seq k also acknowledges every earlier renewal in the same epoch.
  for (auto & [seq, t] : h.sent_at) {
    if (seq <= lease_seq) {
      h.ackers[seq].insert(acker);
    }
  }
}

void OwnershipManager::evaluate(
  const FleetReplica & replica, const MembershipView & view, const PartitionPolicy & policy)
{
  for (auto & [id, h] : held_) {
    const Task * cur = replica.task(id);
    if (cur == nullptr) {
      continue;
    }
    for (auto it = h.sent_at.rbegin(); it != h.sent_at.rend(); ++it) {
      const auto ack_it = h.ackers.find(it->first);
      static const std::set<std::string> kNone;
      const std::set<std::string> & ackers = ack_it == h.ackers.end() ? kNone : ack_it->second;
      if (policy.lease_confirmed(*cur, ackers, view)) {
        h.valid_from = std::max(h.valid_from, it->second);
        h.confirmed_once = true;
        break;
      }
    }
  }
}

bool OwnershipManager::lease_valid(const std::string & task_id, double now_local) const
{
  auto it = held_.find(task_id);
  if (it == held_.end()) {
    return false;
  }
  if (!config_.use_leases || it->second.sticky) {
    return true;
  }
  return now_local < it->second.valid_from + config_.lease_ttl;
}

std::vector<std::string> OwnershipManager::lapsed(double now_local) const
{
  std::vector<std::string> out;
  for (const auto & [id, h] : held_) {
    if (!lease_valid(id, now_local)) {
      out.push_back(id);
    }
  }
  return out;
}

std::vector<std::string> OwnershipManager::lost(const FleetReplica & replica) const
{
  std::vector<std::string> out;
  for (const auto & [id, h] : held_) {
    const Task * cur = replica.task(id);
    if (cur == nullptr) {
      continue;
    }
    const bool mine = cur->owner == self_ && cur->claim_epoch == h.claim_epoch;
    if (!mine) {
      out.push_back(id);
    }
  }
  return out;
}

std::vector<Task> OwnershipManager::commit_ready(
  const FleetReplica & replica, double now_local) const
{
  std::vector<Task> out;
  for (const auto & [id, h] : held_) {
    const Task * cur = replica.task(id);
    if (cur == nullptr || cur->state != TaskState::kClaimed || cur->owner != self_ ||
      cur->claim_epoch != h.claim_epoch)
    {
      continue;
    }
    const bool confirmed = !config_.use_leases || h.confirmed_once;
    if (now_local - h.claimed_local >= config_.t_commit && confirmed &&
      lease_valid(id, now_local))
    {
      out.push_back(commit(*cur));
    }
  }
  return out;
}

void OwnershipManager::mark_sticky(const std::string & task_id)
{
  auto it = held_.find(task_id);
  if (it != held_.end()) {
    it->second.sticky = true;
  }
}

void OwnershipManager::forget(const std::string & task_id)
{
  held_.erase(task_id);
}

double OwnershipManager::observer_timeout() const
{
  return config_.lease_ttl * (1.0 + config_.drift_margin) + config_.grace;
}

std::vector<Task> OwnershipManager::foreign_expired(
  const FleetReplica & replica, double now_local) const
{
  std::vector<Task> out;
  if (!config_.use_leases) {
    return out;
  }
  for (const auto & [id, e] : replica.tasks()) {
    const Task & t = e.task;
    const bool leased = t.state == TaskState::kClaimed || t.state == TaskState::kCommitted;
    if (!leased || t.owner.empty() || t.owner == self_) {
      continue;
    }
    const double ttl = t.lease_ttl > 0.0 ? t.lease_ttl : config_.lease_ttl;
    const double timeout = ttl * (1.0 + config_.drift_margin) + config_.grace;
    if (now_local - e.observed_local > timeout) {
      out.push_back(reopen(t));
    }
  }
  return out;
}

}  // namespace aeropact::core
