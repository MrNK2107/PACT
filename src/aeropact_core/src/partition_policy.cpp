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

#include "aeropact_core/partition_policy.hpp"

namespace aeropact::core
{

std::size_t MembershipView::count_known(const std::set<std::string> & ackers) const
{
  std::size_t n = known.count(self) != 0U ? 1U : 0U;
  for (const auto & a : ackers) {
    if (a != self && known.count(a) != 0U) {
      ++n;
    }
  }
  return n;
}

bool quorum_confirmed(const std::set<std::string> & ackers, const MembershipView & view)
{
  return view.count_known(ackers) >= view.majority();
}

bool PartitionPolicy::is_optimistic_claim(const Task &, const MembershipView &) const
{
  return false;
}

namespace
{

/// New tasks only in shards leased to a member of my sub-group (03 3.5(d)).
class StrictPolicy final : public PartitionPolicy
{
public:
  PartitionPolicyKind kind() const override {return PartitionPolicyKind::kStrict;}

  bool may_claim_new(const Task & task, const MembershipView & view, std::size_t) const override
  {
    auto it = view.shard_holders.find(task.shard);
    return it != view.shard_holders.end() && view.is_reachable(it->second);
  }

  bool lease_confirmed(
    const Task & task, const std::set<std::string> & ackers,
    const MembershipView & view) const override
  {
    if (quorum_confirmed(ackers, view)) {
      return true;
    }
    auto it = view.shard_holders.find(task.shard);
    if (it == view.shard_holders.end()) {
      return false;
    }
    return it->second == view.self || ackers.count(it->second) != 0U;
  }
};

/// New tasks only while a majority of the last-known membership is reachable.
class QuorumPolicy final : public PartitionPolicy
{
public:
  PartitionPolicyKind kind() const override {return PartitionPolicyKind::kQuorum;}

  bool may_claim_new(const Task &, const MembershipView & view, std::size_t) const override
  {
    return view.has_majority();
  }

  bool lease_confirmed(
    const Task &, const std::set<std::string> & ackers,
    const MembershipView & view) const override
  {
    return quorum_confirmed(ackers, view);
  }
};

/// Availability first: bounded optimistic claims of non-urgent tasks, depot arbitration backstops.
class OptimisticBoundedPolicy final : public PartitionPolicy
{
public:
  explicit OptimisticBoundedPolicy(std::size_t max_claims)
  : max_claims_(max_claims) {}

  PartitionPolicyKind kind() const override {return PartitionPolicyKind::kOptimisticBounded;}

  bool may_claim_new(
    const Task & task, const MembershipView & view,
    std::size_t optimistic_in_flight) const override
  {
    if (view.has_majority()) {
      return true;
    }
    auto it = view.shard_holders.find(task.shard);
    if (it != view.shard_holders.end() && view.is_reachable(it->second)) {
      return true;
    }
    return task.priority > 1 && optimistic_in_flight < max_claims_;
  }

  bool lease_confirmed(
    const Task &, const std::set<std::string> &, const MembershipView &) const override
  {
    return true;
  }

  bool is_optimistic_claim(const Task & task, const MembershipView & view) const override
  {
    if (view.has_majority()) {
      return false;
    }
    auto it = view.shard_holders.find(task.shard);
    return !(it != view.shard_holders.end() && view.is_reachable(it->second));
  }

private:
  std::size_t max_claims_;
};

}  // namespace

std::unique_ptr<PartitionPolicy> make_partition_policy(
  PartitionPolicyKind kind, std::size_t max_optimistic_claims)
{
  switch (kind) {
    case PartitionPolicyKind::kStrict:
      return std::make_unique<StrictPolicy>();
    case PartitionPolicyKind::kQuorum:
      return std::make_unique<QuorumPolicy>();
    case PartitionPolicyKind::kOptimisticBounded:
      return std::make_unique<OptimisticBoundedPolicy>(max_optimistic_claims);
  }
  return std::make_unique<QuorumPolicy>();
}

}  // namespace aeropact::core
