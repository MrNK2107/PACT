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

#include <algorithm>
#include <random>
#include <vector>

#include "aeropact_core/merge.hpp"
#include "aeropact_core/replica.hpp"
#include "test_support.hpp"

using aeropact::core::FleetReplica;
using aeropact::core::merge_task;
using aeropact::core::Task;
using aeropact::core::TaskState;
using aeropact::core::test::base_task;
using aeropact::core::test::random_version;

// REQ-STATE-001 / AT-02: merge is a join (commutative, associative, idempotent).
TEST(MergeProperties, JoinLaws)
{
  std::mt19937_64 rng(42);
  const Task base = base_task();
  for (int i = 0; i < 20000; ++i) {
    const Task a = random_version(rng, base);
    const Task b = random_version(rng, base);
    const Task c = random_version(rng, base);
    EXPECT_EQ(merge_task(a, b), merge_task(b, a));
    EXPECT_EQ(merge_task(merge_task(a, b), c), merge_task(a, merge_task(b, c)));
    EXPECT_EQ(merge_task(a, a), a);
  }
}

// I2: the epoch of the merged task never decreases.
TEST(MergeProperties, EpochMonotonic)
{
  std::mt19937_64 rng(7);
  const Task base = base_task();
  for (int i = 0; i < 20000; ++i) {
    const Task a = random_version(rng, base);
    const Task b = random_version(rng, base);
    const Task m = merge_task(a, b);
    EXPECT_GE(m.epoch, a.epoch);
    EXPECT_GE(m.epoch, b.epoch);
  }
}

// Point of no return: a picked-up version beats any pre-pickup version, whatever its epoch.
TEST(MergeProperties, PickedUpBeatsConcurrentReopen)
{
  Task picked = base_task();
  picked.state = TaskState::kPickedUp;
  picked.owner = "A02";
  picked.claim_epoch = 3;
  picked.epoch = 3;
  Task reopened = base_task();
  reopened.state = TaskState::kUnassigned;
  reopened.claim_epoch = 4;
  reopened.epoch = 4;
  const Task m = merge_task(picked, reopened);
  EXPECT_EQ(m.state, TaskState::kPickedUp);
  EXPECT_EQ(m.owner, "A02");
  EXPECT_EQ(m.epoch, 4u);
}

TEST(MergeProperties, DeliveredIsAbsorbing)
{
  Task delivered = base_task();
  delivered.state = TaskState::kDelivered;
  delivered.owner = "A01";
  delivered.claim_epoch = 1;
  delivered.epoch = 1;
  Task aborted = delivered;
  aborted.state = TaskState::kAborted;
  aborted.owner = "A03";
  aborted.claim_epoch = 9;
  aborted.epoch = 9;
  EXPECT_EQ(merge_task(aborted, delivered).state, TaskState::kDelivered);
}

TEST(MergeProperties, HigherBidWinsWithinEpochThenLowerId)
{
  Task a = base_task();
  a.state = TaskState::kClaimed;
  a.claim_epoch = a.epoch = 1;
  a.owner = "A02";
  a.bid = 50;
  Task b = a;
  b.owner = "A05";
  b.bid = 70;
  EXPECT_EQ(merge_task(a, b).owner, "A05");
  b.bid = 50;
  EXPECT_EQ(merge_task(a, b).owner, "A02");
}

// AT-02: replicas fed the same multiset of versions in any order, with duplicates and losses
// covered by a final full sync, converge to the same state.
TEST(MergeProperties, ReplicasConvergeUnderPermutationAndDuplication)
{
  std::mt19937_64 rng(2026);
  for (int round = 0; round < 200; ++round) {
    std::vector<Task> versions;
    for (int task = 0; task < 5; ++task) {
      const Task base = base_task("D1:0000000" + std::to_string(task) + ":0001");
      for (int v = 0; v < 8; ++v) {
        versions.push_back(random_version(rng, base));
      }
    }
    FleetReplica reference;
    for (const auto & v : versions) {
      reference.upsert_task(v, 0.0);
    }
    for (int r = 0; r < 10; ++r) {
      std::vector<Task> shuffled = versions;
      // duplicate a random subset
      std::uniform_int_distribution<std::size_t> pick(0, versions.size() - 1);
      for (int d = 0; d < 10; ++d) {
        shuffled.push_back(versions[pick(rng)]);
      }
      std::shuffle(shuffled.begin(), shuffled.end(), rng);
      FleetReplica replica;
      for (const auto & v : shuffled) {
        replica.upsert_task(v, 0.0);
      }
      EXPECT_EQ(replica.task_digest(), reference.task_digest());
      for (const auto & [id, e] : reference.tasks()) {
        ASSERT_NE(replica.task(id), nullptr);
        EXPECT_EQ(*replica.task(id), e.task);
      }
    }
  }
}
