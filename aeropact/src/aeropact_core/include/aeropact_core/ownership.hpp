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

#ifndef AEROPACT_CORE__OWNERSHIP_HPP_
#define AEROPACT_CORE__OWNERSHIP_HPP_

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "aeropact_core/partition_policy.hpp"
#include "aeropact_core/replica.hpp"
#include "aeropact_core/types.hpp"

namespace aeropact::core
{

struct OwnershipConfig
{
  double lease_ttl{20.0};      ///< s on the owner's local clock
  double renew_period{5.0};    ///< s between renewals
  double drift_margin{0.02};   ///< observers stretch the TTL by this factor
  double grace{2.0};           ///< s added by observers on top of the stretched TTL
  double t_commit{3.0};        ///< s a claim must stand unchallenged before COMMITTED
  bool use_leases{true};       ///< ablation: false disables expiry and zombie-stop (cbba_plain)
};

/**
 * Fenced leases (03 section 3.5(a)-(c), REQ-OWN-001/002).
 *
 * Owner side. A lease is valid until `valid_from + lease_ttl` on the owner's local clock, where
 * `valid_from` is the send time of the latest renewal whose acknowledgements satisfy the partition
 * policy (initially the claim's send time). Because a renewal is only counted after peers have
 * observed it, and observers wait `lease_ttl * (1 + drift_margin) + grace` from their own
 * observation, the old owner always stops before anyone else may start (no zombie owner, I3).
 *
 * After pickup a lease is sticky: it no longer expires on silence (point of no return).
 */
class OwnershipManager
{
public:
  struct HeldLease
  {
    std::string task_id;
    std::uint32_t claim_epoch{0};
    std::uint32_t lease_seq{0};
    double claimed_local{0.0};
    double valid_from{0.0};
    double last_send{0.0};
    bool confirmed_once{false};
    bool sticky{false};
    bool optimistic{false};
    std::map<std::uint32_t, double> sent_at;                ///< lease_seq -> local send time
    std::map<std::uint32_t, std::set<std::string>> ackers;  ///< lease_seq -> ackers
  };

  OwnershipManager(std::string self, OwnershipConfig config);

  const OwnershipConfig & config() const {return config_;}
  const std::string & self() const {return self_;}

  /// Claim record for `current` (UNASSIGNED, or CLAIMED by someone with a lower bid).
  Task claim(const Task & current, double bid, double now_local, bool optimistic = false);
  /// Hold a task assigned by an external authority (the central baseline's hub) at the epoch
  /// the authority gave it. Unlike claim(), no new fencing token is taken.
  void adopt(const Task & assigned, double now_local);
  /// COMMITTED record for a held claim.
  Task commit(const Task & current) const;
  /// UNASSIGNED record that re-opens `current` under a new epoch (release or lease expiry).
  static Task reopen(const Task & current);

  bool holds(const std::string & task_id) const {return held_.count(task_id) != 0U;}
  const HeldLease * held(const std::string & task_id) const;
  const std::map<std::string, HeldLease> & held_leases() const {return held_;}
  std::size_t optimistic_in_flight() const;

  /// Renewal records (lease_seq + 1) for held, non-sticky leases whose renewal is due.
  std::vector<Task> due_renewals(const FleetReplica & replica, double now_local);
  void on_ack(
    const std::string & acker, const std::string & task_id, std::uint32_t claim_epoch,
    std::uint32_t lease_seq);
  /// Re-evaluate pending acknowledgements against the policy and advance `valid_from`.
  void evaluate(
    const FleetReplica & replica, const MembershipView & view, const PartitionPolicy & policy);

  /// Owner-side zombie check (I3): may this node still act on the task right now?
  bool lease_valid(const std::string & task_id, double now_local) const;
  /// Held pre-pickup tasks whose own lease has lapsed; the node must stop acting on them.
  std::vector<std::string> lapsed(double now_local) const;
  /// Held tasks that the replica now shows owned by someone else or re-opened.
  std::vector<std::string> lost(const FleetReplica & replica) const;
  /// Held CLAIMED tasks that stood for t_commit and have a confirmed lease.
  std::vector<Task> commit_ready(const FleetReplica & replica, double now_local) const;

  void mark_sticky(const std::string & task_id);
  void forget(const std::string & task_id);

  /// Observer timeout: lease_ttl * (1 + drift_margin) + grace.
  double observer_timeout() const;
  /// Re-open records for other owners' pre-pickup leases that aged out in this replica.
  std::vector<Task> foreign_expired(const FleetReplica & replica, double now_local) const;

private:
  std::string self_;
  OwnershipConfig config_;
  std::map<std::string, HeldLease> held_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__OWNERSHIP_HPP_
