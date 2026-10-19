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

#ifndef AEROPACT_CORE__PARTITION_POLICY_HPP_
#define AEROPACT_CORE__PARTITION_POLICY_HPP_

#include <cstddef>
#include <map>
#include <memory>
#include <set>
#include <string>

#include "aeropact_core/types.hpp"

namespace aeropact::core
{

/// A node's view of fleet membership and connectivity, rebuilt every coordination tick.
struct MembershipView
{
  std::string self;
  std::set<std::string> known;      ///< last-known members (drones and depots), including self
  std::set<std::string> reachable;  ///< members currently reachable (not suspected), including self
  /// shard id -> holder, for shard leases that are valid in this node's view
  std::map<std::string, std::string> shard_holders;

  std::size_t majority() const {return known.size() / 2 + 1;}
  bool has_majority() const {return reachable.size() >= majority();}
  bool is_reachable(const std::string & id) const {return reachable.count(id) != 0U;}
  /// Number of `ackers` (plus self) that are known members.
  std::size_t count_known(const std::set<std::string> & ackers) const;
};

/**
 * Partition policy (03 section 3.5(f), REQ-OWN-004). Decides
 *   (1) whether a node may claim a *new* (unowned) task given its connectivity, and
 *   (2) whether the acknowledgements collected for a lease renewal confirm the lease, i.e. whether
 *       the owner may keep acting on the task (zombie-stop, I3).
 * Already committed and picked-up tasks proceed under every policy.
 */
class PartitionPolicy
{
public:
  virtual ~PartitionPolicy() = default;
  virtual PartitionPolicyKind kind() const = 0;
  virtual bool may_claim_new(
    const Task & task, const MembershipView & view, std::size_t optimistic_in_flight) const = 0;
  virtual bool lease_confirmed(
    const Task & task, const std::set<std::string> & ackers, const MembershipView & view) const = 0;
  /// True when a claim allowed by this policy is an optimistic one (counts against the budget).
  virtual bool is_optimistic_claim(const Task & task, const MembershipView & view) const;
};

std::unique_ptr<PartitionPolicy> make_partition_policy(
  PartitionPolicyKind kind, std::size_t max_optimistic_claims = 2);

/// Majority quorum over known members, counting self.
bool quorum_confirmed(const std::set<std::string> & ackers, const MembershipView & view);

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__PARTITION_POLICY_HPP_
