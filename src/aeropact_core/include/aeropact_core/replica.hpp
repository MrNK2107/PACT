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

#ifndef AEROPACT_CORE__REPLICA_HPP_
#define AEROPACT_CORE__REPLICA_HPP_

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "aeropact_core/types.hpp"

namespace aeropact::core
{

/// A set of replica entries, used both for delta gossip and for full anti-entropy sync.
struct Delta
{
  std::uint64_t version{0};
  bool full_sync{false};
  std::vector<Task> tasks;
  std::vector<DroneInfo> drones;
  std::vector<PadReservation> pad_adds;
  std::vector<std::string> pad_removes;
  std::vector<ShardLease> shard_leases;

  bool empty() const
  {
    return tasks.empty() && drones.empty() && pad_adds.empty() && pad_removes.empty() &&
           shard_leases.empty();
  }
};

/// A task version change observed while merging or writing (for events and reactions).
struct TaskTransition
{
  std::optional<Task> before;
  Task after;
};

struct MergeResult
{
  std::vector<TaskTransition> tasks;
  std::vector<ShardLease> shard_changes;
  bool drones_changed{false};
  bool pads_changed{false};

  bool changed() const
  {
    return !tasks.empty() || !shard_changes.empty() || drones_changed || pads_changed;
  }
};

struct ReplicaConfig
{
  double terminal_retention_s{300.0};   ///< keep terminal tasks this long before pruning
  double tombstone_retention_s{3600.0};  ///< remember pruned ids this long
};

/**
 * One node's replica of the fleet state (03 section 3.3).
 *
 *  - tasks:          join of TaskRecord versions (merge_task)
 *  - drone status:   LWW by seq
 *  - pad reservations: OR-set (adds by unique tag, removes by tag)
 *  - shard leases:   LWW by (epoch, lease_seq, holder)
 *  - tombstones:     G-set of pruned task ids, expired after a retention period
 *
 * Every change bumps a local version counter; entries remember the version at which they last
 * changed, which makes delta extraction O(entries). Iteration order is deterministic (std::map).
 * All times passed in are the owning node's local monotonic clock.
 */
class FleetReplica
{
public:
  struct TaskEntry
  {
    Task task;
    std::uint64_t changed_at{0};
    double observed_local{0.0};   ///< local time the lease identity last changed
    double terminal_since{-1.0};  ///< local time it became terminal, < 0 if not terminal
  };

  explicit FleetReplica(ReplicaConfig config = {});

  // ---- writes (local and remote use the same join) ----
  std::optional<TaskTransition> upsert_task(const Task & t, double now_local);
  bool upsert_drone(const DroneInfo & d);
  bool add_pad_reservation(const PadReservation & r);
  bool remove_pad_reservation(const std::string & tag);
  std::optional<ShardLease> upsert_shard_lease(const ShardLease & l);

  MergeResult apply(const Delta & delta, double now_local);

  // ---- reads ----
  std::uint64_t version() const {return version_;}
  Delta delta_since(std::uint64_t version) const;
  Delta full_state() const;

  const Task * task(const std::string & id) const;
  const TaskEntry * task_entry(const std::string & id) const;
  const std::map<std::string, TaskEntry> & tasks() const {return tasks_;}
  const DroneInfo * drone(const std::string & id) const;
  const std::map<std::string, DroneInfo> & drones() const {return drones_;}
  const ShardLease * shard_lease(const std::string & shard_id) const;
  const std::map<std::string, ShardLease> & shard_leases() const {return shard_leases_;}
  /// Live pad reservations (added and not removed), ordered by tag.
  std::vector<PadReservation> pad_reservations() const;
  bool is_tombstoned(const std::string & task_id) const;

  /// Drop terminal tasks older than the retention and expire old tombstones.
  std::size_t prune(double now_local);

  /// Digest of the ownership state of every task (id, state, epochs, owner, bid). Lease renewal
  /// counters are left out: they tick every renew period and are not part of what must converge.
  std::uint64_t task_digest() const;

private:
  std::uint64_t bump();

  ReplicaConfig config_;
  std::uint64_t version_{0};
  std::map<std::string, TaskEntry> tasks_;
  std::map<std::string, DroneInfo> drones_;
  std::map<std::string, std::uint64_t> drone_changed_at_;
  std::map<std::string, PadReservation> pad_adds_;
  std::map<std::string, std::uint64_t> pad_add_changed_at_;
  std::map<std::string, std::uint64_t> pad_removes_;  // tag -> version
  std::map<std::string, ShardLease> shard_leases_;
  std::map<std::string, std::uint64_t> shard_changed_at_;
  std::map<std::string, double> tombstones_;  // task id -> local time pruned
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__REPLICA_HPP_
