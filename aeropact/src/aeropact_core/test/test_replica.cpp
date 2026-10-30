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

#include "aeropact_core/replica.hpp"
#include "test_support.hpp"

using aeropact::core::Delta;
using aeropact::core::DroneInfo;
using aeropact::core::FleetReplica;
using aeropact::core::PadReservation;
using aeropact::core::ReplicaConfig;
using aeropact::core::ShardLease;
using aeropact::core::Task;
using aeropact::core::TaskState;
using aeropact::core::test::base_task;
using aeropact::core::test::random_version;

TEST(Replica, DeltaContainsOnlyChangesSinceVersion)
{
  FleetReplica r;
  r.upsert_task(base_task("T1"), 0.0);
  const auto v1 = r.version();
  r.upsert_task(base_task("T2"), 0.0);
  const Delta d = r.delta_since(v1);
  ASSERT_EQ(d.tasks.size(), 1u);
  EXPECT_EQ(d.tasks[0].task_id, "T2");
  EXPECT_EQ(r.full_state().tasks.size(), 2u);
  EXPECT_TRUE(r.full_state().full_sync);
}

TEST(Replica, ReapplyingIsNoChange)
{
  FleetReplica r;
  r.upsert_task(base_task("T1"), 0.0);
  const auto v = r.version();
  EXPECT_FALSE(r.upsert_task(base_task("T1"), 1.0).has_value());
  EXPECT_EQ(r.version(), v);
}

TEST(Replica, DroneStatusIsLastWriterWins)
{
  FleetReplica r;
  DroneInfo d;
  d.drone_id = "A01";
  d.seq = 5;
  d.soc = 0.5f;
  EXPECT_TRUE(r.upsert_drone(d));
  d.seq = 4;
  d.soc = 0.9f;
  EXPECT_FALSE(r.upsert_drone(d));
  EXPECT_FLOAT_EQ(r.drone("A01")->soc, 0.5f);
}

TEST(Replica, PadReservationsAreAnOrSet)
{
  FleetReplica a;
  FleetReplica b;
  PadReservation p{"A01:1", "D1-P1", "D1", "A01", 0, 100, 1};
  a.add_pad_reservation(p);
  b.apply(a.full_state(), 0.0);
  b.remove_pad_reservation("A01:1");
  a.apply(b.full_state(), 0.0);
  EXPECT_TRUE(a.pad_reservations().empty());
  // A concurrent add with a fresh tag survives the remove.
  a.add_pad_reservation({"A01:2", "D1-P1", "D1", "A01", 0, 100, 2});
  b.apply(a.full_state(), 0.0);
  EXPECT_EQ(b.pad_reservations().size(), 1u);
}

TEST(Replica, ShardLeaseOrder)
{
  FleetReplica r;
  r.upsert_shard_lease({"H-0-0", "A02", 1, 0, 20});
  EXPECT_FALSE(r.upsert_shard_lease({"H-0-0", "A03", 1, 0, 20}).has_value());  // higher id loses
  EXPECT_TRUE(r.upsert_shard_lease({"H-0-0", "A01", 1, 0, 20}).has_value());
  EXPECT_TRUE(r.upsert_shard_lease({"H-0-0", "A03", 2, 0, 20}).has_value());   // newer epoch
  EXPECT_EQ(r.shard_lease("H-0-0")->holder, "A03");
}

TEST(Replica, ObservedTimeTracksLeaseIdentity)
{
  FleetReplica r;
  Task t = base_task("T1");
  t.state = TaskState::kClaimed;
  t.owner = "A01";
  t.claim_epoch = t.epoch = 1;
  r.upsert_task(t, 10.0);
  EXPECT_DOUBLE_EQ(r.task_entry("T1")->observed_local, 10.0);
  t.lease_seq = 1;
  r.upsert_task(t, 15.0);
  EXPECT_DOUBLE_EQ(r.task_entry("T1")->observed_local, 15.0);
}

TEST(Replica, PrunesTerminalTasksAndIgnoresResurrection)
{
  ReplicaConfig cfg;
  cfg.terminal_retention_s = 10;
  FleetReplica r(cfg);
  Task t = base_task("T1");
  t.state = TaskState::kDelivered;
  t.owner = "A01";
  r.upsert_task(t, 0.0);
  EXPECT_EQ(r.prune(5.0), 0u);
  EXPECT_EQ(r.prune(11.0), 1u);
  EXPECT_EQ(r.task("T1"), nullptr);
  EXPECT_FALSE(r.upsert_task(t, 12.0).has_value());
}

// AT-10 style: two replicas exchanging lossy deltas converge after a full sync each way.
TEST(Replica, LossyDeltaGossipConvergesAfterAntiEntropy)
{
  std::mt19937_64 rng(11);
  FleetReplica a;
  FleetReplica b;
  std::uniform_real_distribution<double> u(0.0, 1.0);
  std::uint64_t a_sent = 0;
  std::uint64_t b_sent = 0;
  for (int step = 0; step < 500; ++step) {
    const Task base = base_task("T" + std::to_string(step % 17));
    (u(rng) < 0.5 ? a : b).upsert_task(random_version(rng, base), step);
    if (step % 5 == 0) {
      const Delta da = a.delta_since(a_sent);
      a_sent = a.version();
      if (u(rng) > 0.4) {
        b.apply(da, step);
      }
      const Delta db = b.delta_since(b_sent);
      b_sent = b.version();
      if (u(rng) > 0.4) {
        a.apply(db, step);
      }
    }
  }
  a.apply(b.full_state(), 1000);
  b.apply(a.full_state(), 1000);
  EXPECT_EQ(a.task_digest(), b.task_digest());
}
