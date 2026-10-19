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

#include "aeropact_core/auction.hpp"
#include "aeropact_core/world_model.hpp"
#include "test_support.hpp"

using aeropact::core::Auction;
using aeropact::core::AuctionConfig;
using aeropact::core::BidderState;
using aeropact::core::EnergyModel;
using aeropact::core::Task;
using aeropact::core::TaskState;
using aeropact::core::WorldModel;
using aeropact::core::test::base_task;

namespace
{

WorldModel small_world()
{
  return WorldModel::from_yaml_string(
      R"(
world:
  name: test
  bounds: {min_x: -500, min_y: -500, max_x: 500, max_y: 500}
  depots:
    - id: D1
      position: [0, 0, 0]
      handoff: [5, 0, 0]
      pads:
        - {id: D1-P1, position: [10, 0, 0]}
  no_fly:
    - {id: NF1, polygon: [[100, -50], [150, -50], [150, 50], [100, 50]]}
)");
}

Task task_at(const std::string & id, double x, double y, int priority, double deadline)
{
  Task t = base_task(id);
  t.pickup = {5, 0, 0};
  t.drop = {x, y, 0};
  t.priority = static_cast<std::uint8_t>(priority);
  t.deadline = deadline;
  return t;
}

}  // namespace

TEST(Auction, PrefersUrgentAndNearTasks)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  Auction auction(AuctionConfig{}, energy, world);
  BidderState me{"A01", {0, 0, 0}, 0.95, 2.0, 0.0, {}};
  const std::vector<Task> candidates{
    task_at("far", -400, 400, 3, 2000), task_at("near", -50, 50, 3, 2000),
    task_at("urgent", -300, -300, 1, 2000)};
  const auto bids = auction.build_bundle(me, candidates, {});
  ASSERT_FALSE(bids.empty());
  EXPECT_EQ(bids.front().task.task_id, "urgent");
  EXPECT_LE(bids.size(), 3u);
}

TEST(Auction, RejectsWhenReserveWouldBeViolated)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  Auction auction(AuctionConfig{}, energy, world);
  BidderState me{"A01", {0, 0, 0}, 0.27, 2.0, 0.0, {}};
  const auto bids = auction.build_bundle(me, {task_at("far", -450, 450, 2, 2000)}, {});
  EXPECT_TRUE(bids.empty());
}

TEST(Auction, RejectsOverweightParcels)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  Auction auction(AuctionConfig{}, energy, world);
  BidderState me{"A01", {0, 0, 0}, 0.95, 1.0, 0.0, {}};
  Task heavy = task_at("heavy", -50, 50, 2, 2000);
  heavy.weight_kg = 1.5f;
  EXPECT_TRUE(auction.build_bundle(me, {heavy}, {}).empty());
}

TEST(Auction, OutbidRequiresStrictlyHigherScore)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  Auction auction(AuctionConfig{}, energy, world);
  BidderState me{"A01", {0, 0, 0}, 0.95, 2.0, 0.0, {}};
  Task t = task_at("t", -50, 50, 2, 2000);
  t.state = TaskState::kClaimed;
  t.owner = "A02";
  t.bid = 1e6;
  EXPECT_TRUE(auction.build_bundle(me, {t}, {}).empty());
  t.bid = -1e6;
  EXPECT_EQ(auction.build_bundle(me, {t}, {}).size(), 1u);
}

TEST(Auction, CountsNoFlyCrossings)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  Auction auction(AuctionConfig{}, energy, world);
  EXPECT_EQ(auction.crossings({0, 0, 0}, {300, 0, 0}), 1);
  EXPECT_EQ(auction.crossings({0, 0, 0}, {0, 300, 0}), 0);
}

TEST(Auction, BundleRespectsLength)
{
  const WorldModel world = small_world();
  const EnergyModel energy;
  AuctionConfig cfg;
  cfg.bundle_len = 2;
  Auction auction(cfg, energy, world);
  BidderState me{"A01", {0, 0, 0}, 1.0, 2.0, 0.0, {}};
  std::vector<Task> c;
  for (int i = 0; i < 6; ++i) {
    c.push_back(task_at("t" + std::to_string(i), -30.0 * i, 20, 2, 5000));
  }
  EXPECT_EQ(auction.build_bundle(me, c, {}).size(), 2u);
}
