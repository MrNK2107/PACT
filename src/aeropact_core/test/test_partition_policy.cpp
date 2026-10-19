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

#include <gtest/gtest.h>

#include "aeropact_core/partition_policy.hpp"
#include "test_support.hpp"

using aeropact::core::make_partition_policy;
using aeropact::core::MembershipView;
using aeropact::core::PartitionPolicyKind;
using aeropact::core::Task;
using aeropact::core::test::base_task;

namespace
{

MembershipView view(std::size_t reachable)
{
  MembershipView v;
  v.self = "A01";
  v.known = {"A01", "A02", "A03", "A04", "D1"};
  const char * ids[] = {"A01", "A02", "A03", "A04", "D1"};
  for (std::size_t i = 0; i < reachable; ++i) {
    v.reachable.insert(ids[i]);
  }
  return v;
}

}  // namespace

TEST(PartitionPolicy, QuorumNeedsMajority)
{
  auto p = make_partition_policy(PartitionPolicyKind::kQuorum);
  const Task t = base_task();
  EXPECT_TRUE(p->may_claim_new(t, view(3), 0));
  EXPECT_FALSE(p->may_claim_new(t, view(2), 0));
  EXPECT_TRUE(p->lease_confirmed(t, {"A02", "A03"}, view(5)));
  EXPECT_FALSE(p->lease_confirmed(t, {"A02"}, view(5)));
}

TEST(PartitionPolicy, StrictFollowsShardHolder)
{
  auto p = make_partition_policy(PartitionPolicyKind::kStrict);
  Task t = base_task();
  t.shard = "H-2-2";
  MembershipView v = view(2);  // A01, A02
  EXPECT_FALSE(p->may_claim_new(t, v, 0));
  v.shard_holders["H-2-2"] = "A04";  // holder in the other partition
  EXPECT_FALSE(p->may_claim_new(t, v, 0));
  v.shard_holders["H-2-2"] = "A02";
  EXPECT_TRUE(p->may_claim_new(t, v, 0));
  EXPECT_TRUE(p->lease_confirmed(t, {"A02"}, v));
}

TEST(PartitionPolicy, OptimisticIsBoundedAndSkipsUrgent)
{
  auto p = make_partition_policy(PartitionPolicyKind::kOptimisticBounded, 2);
  Task t = base_task();
  t.priority = 2;
  EXPECT_TRUE(p->may_claim_new(t, view(1), 0));
  EXPECT_TRUE(p->may_claim_new(t, view(1), 1));
  EXPECT_FALSE(p->may_claim_new(t, view(1), 2));
  t.priority = 1;
  EXPECT_FALSE(p->may_claim_new(t, view(1), 0));
  EXPECT_TRUE(p->is_optimistic_claim(t, view(1)));
  EXPECT_FALSE(p->is_optimistic_claim(t, view(4)));
}
