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

#include "aeropact_core/world_model.hpp"

using aeropact::core::WorldModel;

TEST(WorldModel, ParsesDepotsPadsDropsAndZones)
{
  const auto w =
    WorldModel::from_yaml_string(
    R"(
world:
  name: t
  bounds: {min_x: -100, min_y: -100, max_x: 100, max_y: 100}
  shard_size_m: 120
  wind: {mean_mps: 4, dir_deg: 90}
  depots:
    - id: D1
      position: [0, 0, 0]
      handoff: [4, 0, 0]
      pads:
        - {id: D1-P1, position: [10, 0, 0]}
        - {id: D1-P2, position: [10, 5, 0]}
  public_pads:
    - {id: PUB1, position: [-50, -50, 0]}
  drop_points:
    - {id: DP1, position: [50, 50, 0], cluster: c1, kind: hospital}
  no_fly:
    - {id: NF, polygon: [[20, 20], [30, 20], [30, 30], [20, 30]], ceiling_m: 60}
)");
  EXPECT_EQ(w.name, "t");
  EXPECT_DOUBLE_EQ(w.shard_size_m, 120);
  EXPECT_NEAR(w.wind.y, 4.0, 1e-9);
  ASSERT_NE(w.depot("D1"), nullptr);
  EXPECT_EQ(w.depot("D1")->pad_ids.size(), 2u);
  EXPECT_EQ(w.pads.size(), 3u);
  EXPECT_EQ(w.nearest_pad({-40, -40, 0})->id, "PUB1");
  EXPECT_EQ(w.drop_point("DP1")->kind, "hospital");
  EXPECT_TRUE(w.in_no_fly(25, 25, 40));
  EXPECT_FALSE(w.in_no_fly(25, 25, 70));
  EXPECT_FALSE(w.in_no_fly(0, 0, 40));
}

TEST(WorldModel, LoadsGeneratedFixture)
{
  const auto w = WorldModel::load(std::string(TEST_DATA_DIR) + "/world_fixture.yaml");
  EXPECT_FALSE(w.depots.empty());
  EXPECT_FALSE(w.drop_points.empty());
}
