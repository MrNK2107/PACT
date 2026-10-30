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

#include "aeropact_depot/arbiter.hpp"

using aeropact::core::Task;
using aeropact::core::TaskState;
using aeropact::depot::PadArbiter;
using aeropact::depot::ParcelArbiter;
using aeropact::depot::PickupResult;

namespace
{

Task committed(const std::string & owner, std::uint32_t epoch)
{
  Task t;
  t.task_id = "T1";
  t.state = TaskState::kCommitted;
  t.owner = owner;
  t.claim_epoch = epoch;
  t.epoch = epoch;
  return t;
}

}  // namespace

TEST(ParcelArbiter, OneParcelPerTask)
{
  ParcelArbiter a;
  const Task t = committed("A01", 2);
  EXPECT_EQ(a.request(&t, "T1", "A01", 2), PickupResult::kGrant);
  EXPECT_EQ(a.request(&t, "T1", "A01", 2), PickupResult::kTaskTaken);
  EXPECT_EQ(a.request(&t, "T1", "A02", 3), PickupResult::kTaskTaken);
}

// AT-04: a zombie owner with a stale fencing token is refused at pickup.
TEST(ParcelArbiter, StaleEpochIsRefused)
{
  ParcelArbiter a;
  Task t = committed("A02", 4);  // re-assigned after A01's lease expired
  EXPECT_EQ(a.request(&t, "T1", "A01", 3), PickupResult::kStaleEpoch);
  EXPECT_EQ(a.request(&t, "T1", "A02", 4), PickupResult::kGrant);
}

TEST(ParcelArbiter, LaggingDepotAcceptsNewerToken)
{
  ParcelArbiter a;
  Task t = committed("A01", 2);  // depot has not yet heard of A03's newer claim
  EXPECT_EQ(a.request(&t, "T1", "A03", 3), PickupResult::kGrant);
}

TEST(ParcelArbiter, NonOwnerWithSameEpochIsRefused)
{
  ParcelArbiter a;
  Task t = committed("A01", 2);
  EXPECT_EQ(a.request(&t, "T1", "A02", 2), PickupResult::kTaskTaken);
}

TEST(ParcelArbiter, WithoutArbitrationEveryoneGetsAParcel)
{
  ParcelArbiter a(false);
  const Task t = committed("A01", 2);
  EXPECT_EQ(a.request(&t, "T1", "A01", 2), PickupResult::kGrant);
  EXPECT_EQ(a.request(&t, "T1", "A02", 1), PickupResult::kGrant);
  EXPECT_EQ(a.parcels_handed(), 2u);
}

TEST(BayArbiter, OneDronePerBayFreedWhenItLeaves)
{
  aeropact::depot::BayArbiter b;
  b.add_bay("B0", {0, 0, 0});
  b.add_bay("B1", {0, 14, 0});
  EXPECT_EQ(b.reserve("A01", 0)->id, "B0");
  EXPECT_EQ(b.reserve("A01", 1)->id, "B0");  // idempotent
  EXPECT_EQ(b.reserve("A02", 1)->id, "B1");
  EXPECT_FALSE(b.reserve("A03", 1).has_value());
  // A01 arrives, then climbs away: its bay is freed.
  EXPECT_TRUE(b.observe("A01", {0, 0, 3}, 10, 6, 20, 120).empty());
  EXPECT_EQ(b.observe("A01", {0, 0, 30}, 20, 6, 20, 120).size(), 1u);
  EXPECT_EQ(b.reserve("A03", 21)->id, "B0");
}

TEST(BayArbiter, UnusedGrantTimesOut)
{
  aeropact::depot::BayArbiter b;
  b.add_bay("B0", {0, 0, 0});
  b.reserve("A01", 0);
  EXPECT_TRUE(b.observe("A01", {300, 0, 40}, 50, 6, 20, 120).empty());
  EXPECT_EQ(b.observe("A01", {300, 0, 40}, 121, 6, 20, 120).size(), 1u);
}

TEST(PadArbiter, OneHolderPerPadAndStickyOwnPad)
{
  PadArbiter p;
  p.add_pad("P1", {0, 0, 0});
  p.add_pad("P2", {5, 0, 0});
  EXPECT_EQ(p.reserve("A01")->id, "P1");
  EXPECT_EQ(p.reserve("A01")->id, "P1");
  EXPECT_EQ(p.reserve("A02")->id, "P2");
  EXPECT_FALSE(p.reserve("A03").has_value());
  EXPECT_TRUE(p.release("A01", "P1"));
  EXPECT_EQ(p.reserve("A03")->id, "P1");
}

TEST(PadArbiter, AbsentHolderLosesThePadButATravellerKeepsIt)
{
  PadArbiter p;
  p.add_pad("P1", {0, 0, 0});
  p.assign("A01", "P1");
  EXPECT_TRUE(p.observe("A01", {0, 0, 0.1}, 1.0).empty());
  EXPECT_EQ(p.observe("A01", {200, 0, 40}, 50.0).size(), 1u);  // left on a mission
  p.reserve("A02", 60.0);
  EXPECT_TRUE(p.observe("A02", {400, 0, 40}, 200.0).empty());   // still on its way
  EXPECT_EQ(p.observe("A02", {400, 0, 40}, 400.0).size(), 1u);  // never came
}

TEST(PadArbiter, UnpoweredPadsAreNotGranted)
{
  PadArbiter p;
  p.add_pad("P1", {0, 0, 0});
  p.set_powered("P1", false);
  EXPECT_FALSE(p.reserve("A01").has_value());
  EXPECT_EQ(p.free_powered(), 0u);
}

TEST(PadArbiter, PadSensorBlocksOccupiedPadsAndFreesVacatedOnes)
{
  PadArbiter p;
  p.add_pad("P1", {0, 0, 0});
  p.add_pad("P2", {12, 0, 0});
  // Something nobody booked sits on P1 (an unannounced vehicle, a crate): it is never granted.
  p.sense("P1", true);
  auto g = p.reserve("A01", 0.0);
  ASSERT_TRUE(g.has_value());
  EXPECT_EQ(g->id, "P2");
  EXPECT_FALSE(p.reserve("A02", 0.0).has_value()) << "only an occupied pad is left";
  // A01 lands on P2 (sensor: occupied) and later leaves (sensor: empty): P2 is freed.
  EXPECT_FALSE(p.sense("P2", true));
  EXPECT_TRUE(p.sense("P2", false));
  EXPECT_TRUE(p.pads().at("P2").holder.empty());
  // A pad reported empty before its holder ever arrived stays booked (the grant is not lost).
  auto g2 = p.reserve("A03", 1.0);
  ASSERT_TRUE(g2.has_value());
  EXPECT_FALSE(p.sense(g2->id, false));
  EXPECT_EQ(p.pads().at(g2->id).holder, "A03");
  // P1 cleared: grantable again.
  p.sense("P1", false);
  EXPECT_TRUE(p.reserve("A02", 2.0).has_value());
}
