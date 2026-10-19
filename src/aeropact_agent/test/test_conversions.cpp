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

#include "aeropact_agent/conversions.hpp"

using aeropact::agent::from_msg;
using aeropact::agent::to_msg;
namespace core = aeropact::core;

TEST(Conversions, TaskRoundTrip)
{
  core::Task t;
  t.task_id = "D1:00000001:00ab";
  t.origin_depot = "D1";
  t.pickup = {1, 2, 3};
  t.drop = {4, 5, 6};
  t.priority = 1;
  t.deadline = 600;
  t.weight_kg = 1.25f;
  t.shard = "H-1-2";
  t.state = core::TaskState::kCommitted;
  t.epoch = 4;
  t.claim_epoch = 3;
  t.owner = "A07";
  t.bid = 99.5;
  t.lease_ttl = 20;
  t.lease_seq = 6;
  t.created_at = 12;
  t.replaces = "D1:00000000:0001";
  t.abort_reason = "";
  EXPECT_EQ(from_msg(to_msg(t)), t);
}

TEST(Conversions, DeltaRoundTripPreservesEverySection)
{
  core::Delta d;
  d.version = 17;
  d.full_sync = true;
  core::Task t;
  t.task_id = "T";
  d.tasks.push_back(t);
  core::DroneInfo dr;
  dr.drone_id = "A01";
  dr.seq = 3;
  dr.bundle = {"T"};
  d.drones.push_back(dr);
  d.pad_adds.push_back({"A01:1", "D1-P1", "D1", "A01", 1, 2, 3});
  d.pad_removes.push_back("A02:9");
  d.shard_leases.push_back({"H-0-0", "A01", 2, 5, 30});
  const core::Delta r = from_msg(to_msg(d));
  EXPECT_EQ(r.version, 17u);
  EXPECT_TRUE(r.full_sync);
  ASSERT_EQ(r.tasks.size(), 1u);
  ASSERT_EQ(r.drones.size(), 1u);
  EXPECT_EQ(r.drones[0].bundle, dr.bundle);
  ASSERT_EQ(r.pad_adds.size(), 1u);
  EXPECT_EQ(r.pad_adds[0].tag, "A01:1");
  EXPECT_EQ(r.pad_removes, d.pad_removes);
  ASSERT_EQ(r.shard_leases.size(), 1u);
  EXPECT_EQ(r.shard_leases[0].lease_seq, 5u);
}

TEST(Conversions, OutOfRangeEnumsAreSanitised)
{
  aeropact_interfaces::msg::TaskRecord m;
  m.state = 200;
  EXPECT_EQ(from_msg(m).state, core::TaskState::kUnassigned);
  aeropact_interfaces::msg::DroneState d;
  d.health = 77;
  d.activity = 99;
  EXPECT_EQ(from_msg(d).health, core::Health::kOk);
  EXPECT_EQ(from_msg(d).activity, core::Activity::kIdle);
}
