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
#include "mission.hpp"

using aeropact::agent::build_leg;
using aeropact::agent::cruise_layer;
using aeropact::agent::LegEnd;
using aeropact::agent::LegRequest;
using aeropact::core::RoutePlanner;
using aeropact::core::WorldModel;

TEST(Mission, LegClimbsCruisesAndDescends)
{
  WorldModel w =
    WorldModel::from_yaml_string(
    R"(
world:
  name: t
  bounds: {min_x: -300, min_y: -300, max_x: 300, max_y: 300}
)");
  RoutePlanner planner(w);
  LegRequest req;
  req.from = {-100, 0, 0.2};
  req.to = {100, 50, 0.2};
  req.cruise_alt = 40;
  req.end = LegEnd::kLand;
  const auto wps = build_leg(planner, req);
  ASSERT_TRUE(wps.has_value());
  ASSERT_EQ(wps->size(), 3u);
  EXPECT_DOUBLE_EQ((*wps)[0].x, -100);
  EXPECT_DOUBLE_EQ((*wps)[0].z, 40);
  EXPECT_DOUBLE_EQ((*wps)[1].x, 100);
  EXPECT_DOUBLE_EQ((*wps)[1].z, 40);
  EXPECT_DOUBLE_EQ((*wps)[2].z, 0.2);
}

TEST(Mission, CruiseLayersSpreadByIdNumber)
{
  EXPECT_DOUBLE_EQ(cruise_layer("A01", 30, 6, 4), 36);
  EXPECT_DOUBLE_EQ(cruise_layer("A04", 30, 6, 4), 30);
  EXPECT_DOUBLE_EQ(cruise_layer("A06", 30, 6, 4), 42);
}
