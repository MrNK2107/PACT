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

#include <random>
#include <set>

#include "aeropact_core/clock.hpp"
#include "aeropact_core/ownership.hpp"
#include "test_support.hpp"

using aeropact::core::FleetReplica;
using aeropact::core::LocalClock;
using aeropact::core::make_partition_policy;
using aeropact::core::MembershipView;
using aeropact::core::OwnershipConfig;
using aeropact::core::OwnershipManager;
using aeropact::core::PartitionPolicyKind;
using aeropact::core::Task;
using aeropact::core::TaskState;
using aeropact::core::test::base_task;

namespace
{

MembershipView view_of(
  const std::string & self, std::set<std::string> known,
  std::set<std::string> reachable)
{
  MembershipView v;
  v.self = self;
  v.known = std::move(known);
  v.reachable = std::move(reachable);
  return v;
}

}  // namespace

TEST(Ownership, ClaimTakesNewEpochAndOutbidKeepsIt)
{
  OwnershipManager a("A01", {});
  Task t = base_task();
  t.epoch = t.claim_epoch = 3;
  const Task c = a.claim(t, 40.0, 0.0);
  EXPECT_EQ(c.state, TaskState::kClaimed);
  EXPECT_EQ(c.claim_epoch, 4u);
  EXPECT_EQ(c.epoch, 4u);
  OwnershipManager b("A02", {});
  const Task o = b.claim(c, 55.0, 0.5);
  EXPECT_EQ(o.claim_epoch, 4u);
  EXPECT_EQ(o.owner, "A02");
}

TEST(Ownership, CommitNeedsConfirmedLeaseAndTCommit)
{
  OwnershipConfig cfg;
  OwnershipManager own("A01", cfg);
  auto policy = make_partition_policy(PartitionPolicyKind::kQuorum);
  FleetReplica replica;
  Task t = own.claim(base_task(), 50.0, 0.0);
  replica.upsert_task(t, 0.0);
  const auto view = view_of("A01", {"A01", "A02", "A03"}, {"A01", "A02", "A03"});
  EXPECT_TRUE(own.commit_ready(replica, 5.0).empty());  // nobody acked yet
  own.on_ack("A02", t.task_id, t.claim_epoch, 0);
  own.evaluate(replica, view, *policy);
  EXPECT_TRUE(own.commit_ready(replica, 1.0).empty());  // before t_commit
  ASSERT_EQ(own.commit_ready(replica, 3.5).size(), 1u);
}

TEST(Ownership, MinorityOwnerStopsBeforeMajorityReassigns)
{
  OwnershipConfig cfg;
  OwnershipManager owner("A01", cfg);
  auto policy = make_partition_policy(PartitionPolicyKind::kQuorum);
  FleetReplica owner_replica;
  FleetReplica observer_replica;
  Task t = owner.claim(base_task(), 50.0, 0.0);
  owner_replica.upsert_task(t, 0.0);
  observer_replica.upsert_task(t, 0.0);
  const auto connected = view_of("A01", {"A01", "A02", "A03"}, {"A01", "A02", "A03"});
  owner.on_ack("A02", t.task_id, t.claim_epoch, 0);
  owner.evaluate(owner_replica, connected, *policy);
  // Partition at t=1: the owner keeps renewing but nobody hears it.
  const auto alone = view_of("A01", {"A01", "A02", "A03"}, {"A01"});
  double owner_stop = -1.0;
  for (double now = 1.0; now < 60.0; now += 0.1) {
    for (const auto & r : owner.due_renewals(owner_replica, now)) {
      owner_replica.upsert_task(r, now);
    }
    owner.evaluate(owner_replica, alone, *policy);
    if (owner_stop < 0.0 && !owner.lease_valid(t.task_id, now)) {
      owner_stop = now;
    }
  }
  ASSERT_GT(owner_stop, 0.0);
  // Observers reopen only after ttl * (1 + margin) + grace from their last observation.
  OwnershipManager observer("A02", cfg);
  EXPECT_TRUE(observer.foreign_expired(observer_replica, owner_stop).empty());
  EXPECT_FALSE(observer.foreign_expired(observer_replica, 0.0 + observer.observer_timeout() + 0.01)
    .empty());
  EXPECT_LT(owner_stop, observer.observer_timeout());
}

// I3 / AT-09 property: with clock drift up to the margin, the old owner always stops (in
// reference time) before any observer may reopen, for random renewal and ack schedules.
TEST(Ownership, ZombieStopHoldsUnderDriftProperty)
{
  std::mt19937_64 rng(99);
  std::uniform_real_distribution<double> drift(-10000.0, 10000.0);  // up to 1 %
  std::uniform_real_distribution<double> part(2.0, 60.0);
  std::uniform_real_distribution<double> delay(0.0, 0.8);
  OwnershipConfig cfg;  // drift_margin 0.02 > 2 * 1 %
  auto policy = make_partition_policy(PartitionPolicyKind::kQuorum);
  for (int trial = 0; trial < 300; ++trial) {
    LocalClock owner_clock(drift(rng), 100.0);
    LocalClock observer_clock(drift(rng), -50.0);
    OwnershipManager owner("A01", cfg);
    OwnershipManager observer("A02", cfg);
    FleetReplica owner_replica;
    FleetReplica observer_replica;
    const auto connected = view_of("A01", {"A01", "A02", "A03"}, {"A01", "A02", "A03"});
    const auto alone = view_of("A01", {"A01", "A02", "A03"}, {"A01"});
    const double partition_at = part(rng);
    const double d = delay(rng);
    Task t = owner.claim(base_task(), 50.0, owner_clock.now(0.0));
    owner_replica.upsert_task(t, owner_clock.now(0.0));
    double owner_stop_ref = -1.0;
    double observer_reopen_ref = -1.0;
    for (double ref = 0.0; ref < 200.0; ref += 0.05) {
      const double ol = owner_clock.now(ref);
      const double bl = observer_clock.now(ref);
      const bool connected_now = ref < partition_at;
      for (const auto & r : owner.due_renewals(owner_replica, ol)) {
        owner_replica.upsert_task(r, ol);
      }
      if (connected_now && ref > d) {
        // Observer sees the owner's latest record after a delay and acks it.
        const Task * cur = owner_replica.task(t.task_id);
        observer_replica.upsert_task(*cur, bl);
        owner.on_ack("A02", cur->task_id, cur->claim_epoch, cur->lease_seq);
        owner.on_ack("A03", cur->task_id, cur->claim_epoch, cur->lease_seq);
      }
      owner.evaluate(owner_replica, connected_now ? connected : alone, *policy);
      if (owner_stop_ref < 0.0 && !owner.lease_valid(t.task_id, ol)) {
        owner_stop_ref = ref;
      }
      if (observer_reopen_ref < 0.0 && observer_replica.task(t.task_id) != nullptr &&
        !observer.foreign_expired(observer_replica, bl).empty())
      {
        observer_reopen_ref = ref;
      }
    }
    ASSERT_GT(owner_stop_ref, 0.0) << "trial " << trial;
    ASSERT_GT(observer_reopen_ref, 0.0) << "trial " << trial;
    EXPECT_LT(owner_stop_ref, observer_reopen_ref) << "trial " << trial;
  }
}

TEST(Ownership, AdoptKeepsTheAssignedEpoch)
{
  OwnershipManager own("A01", {});
  FleetReplica replica;
  Task t = base_task();
  t.state = TaskState::kCommitted;
  t.owner = "A01";
  t.epoch = t.claim_epoch = 7;
  replica.upsert_task(t, 0.0);
  own.adopt(t, 0.0);
  EXPECT_TRUE(own.lost(replica).empty());
  EXPECT_EQ(own.held(t.task_id)->claim_epoch, 7u);
}

TEST(Ownership, StickyAfterPickupNeverLapses)
{
  OwnershipManager own("A01", {});
  Task t = own.claim(base_task(), 50.0, 0.0);
  own.mark_sticky(t.task_id);
  EXPECT_TRUE(own.lease_valid(t.task_id, 1e6));
  EXPECT_TRUE(own.lapsed(1e6).empty());
}

TEST(Ownership, LostWhenReplicaShowsAnotherOwner)
{
  OwnershipManager own("A01", {});
  FleetReplica replica;
  Task t = own.claim(base_task(), 50.0, 0.0);
  replica.upsert_task(t, 0.0);
  EXPECT_TRUE(own.lost(replica).empty());
  Task other = t;
  other.owner = "A02";
  other.bid = 90.0;
  replica.upsert_task(other, 0.1);
  ASSERT_EQ(own.lost(replica).size(), 1u);
}

TEST(Ownership, ReopenBumpsEpochAndClearsOwner)
{
  Task t = base_task();
  t.state = TaskState::kCommitted;
  t.owner = "A01";
  t.epoch = t.claim_epoch = 5;
  const Task r = OwnershipManager::reopen(t);
  EXPECT_EQ(r.state, TaskState::kUnassigned);
  EXPECT_TRUE(r.owner.empty());
  EXPECT_EQ(r.claim_epoch, 6u);
  EXPECT_EQ(r.epoch, 6u);
}
