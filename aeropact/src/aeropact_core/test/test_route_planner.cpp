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

#include "aeropact_core/route_planner.hpp"
#include "aeropact_core/world_model.hpp"

using aeropact::core::NoFlyZone;
using aeropact::core::RoutePlanner;
using aeropact::core::Vec3;
using aeropact::core::WorldModel;

namespace
{

WorldModel wall_world()
{
  return WorldModel::from_yaml_string(
      R"(
world:
  name: wall
  bounds: {min_x: -300, min_y: -300, max_x: 300, max_y: 300}
  no_fly:
    - {id: WALL, polygon: [[-20, -200], [20, -200], [20, 300], [-20, 300]]}
  buildings:
    - {id: B1, footprint: [[100, 100], [140, 100], [140, 140], [100, 140]], height_m: 60}
    - {id: B2, footprint: [[-150, -50], [-120, -50], [-120, -20], [-150, -20]], height_m: 10}
)");
}

}  // namespace

TEST(RoutePlanner, StraightWhenClear)
{
  WorldModel w = wall_world();
  RoutePlanner p(w);
  const auto path = p.plan({-200, -250, 0}, {-100, -250, 0}, 35);
  ASSERT_TRUE(path.has_value());
  EXPECT_EQ(path->size(), 2u);
}

TEST(RoutePlanner, RoutesAroundNoFlyZone)
{
  WorldModel w = wall_world();
  RoutePlanner p(w);
  const Vec3 a{-150, 100, 0};
  const Vec3 b{220, 100, 0};  // clear of B1 and its inflation
  const auto path = p.plan(a, b, 35);
  ASSERT_TRUE(path.has_value());
  EXPECT_GT(path->size(), 2u);
  for (std::size_t i = 1; i < path->size(); ++i) {
    EXPECT_TRUE(p.segment_clear((*path)[i - 1], (*path)[i], 35)) << "segment " << i;
  }
  EXPECT_GT(RoutePlanner::length(*path), 300.0);
}

TEST(RoutePlanner, TallBuildingsBlockLowLayersOnly)
{
  WorldModel w = wall_world();
  RoutePlanner p(w);
  EXPECT_FALSE(p.segment_clear({80, 120, 0}, {160, 120, 0}, 35));
  EXPECT_FALSE(p.segment_clear({80, 120, 0}, {160, 120, 0}, 60));
  EXPECT_TRUE(p.segment_clear({80, 120, 0}, {160, 120, 0}, 80));
  EXPECT_TRUE(p.segment_clear({-170, -35, 0}, {-100, -35, 0}, 35));  // low building
}

TEST(RoutePlanner, DynamicRestrictionInvalidatesCache)
{
  WorldModel w = wall_world();
  RoutePlanner p(w);
  EXPECT_TRUE(p.segment_clear({-200, -250, 0}, {-100, -250, 0}, 35));
  NoFlyZone z;
  z.id = "TFR";
  z.polygon = {{-160, -280}, {-140, -280}, {-140, -220}, {-160, -220}};
  w.set_restriction(z);
  EXPECT_FALSE(p.segment_clear({-200, -250, 0}, {-100, -250, 0}, 35));
}

TEST(RoutePlanner, NoRouteWhenSealed)
{
  WorldModel w =
    WorldModel::from_yaml_string(
    R"(
world:
  name: sealed
  bounds: {min_x: -200, min_y: -200, max_x: 200, max_y: 200}
  no_fly:
    - {id: RING, polygon: [[-60, -200], [60, -200], [60, 200], [-60, 200]]}
)");
  RoutePlanner p(w);
  EXPECT_FALSE(p.plan({-150, 0, 0}, {150, 0, 0}, 35).has_value());
}

TEST(RoutePlanner, GoalInsideMarginIsReachedWithoutCrossingObstacles)
{
  WorldModel w =
    WorldModel::from_yaml_string(
    R"(
world:
  name: tower
  bounds: {min_x: -300, min_y: -300, max_x: 300, max_y: 300}
  buildings:
    - {id: T, footprint: [[-20, -20], [20, -20], [20, 20], [-20, 20]], height_m: 80}
)");
  RoutePlanner p(w);
  // Drop point on the street 8 m from the tower, inside its inflation margin.
  const auto path = p.plan({-200, 0, 0}, {28, 0, 0}, 35);
  ASSERT_TRUE(path.has_value());
  for (const auto & wp : *path) {
    EXPECT_FALSE(wp.x > -20 && wp.x<20 && wp.y>-20 && wp.y < 20) << wp.x << "," << wp.y;
  }
  for (std::size_t i = 1; i < path->size(); ++i) {
    const auto & a = (*path)[i - 1];
    const auto & b = (*path)[i];
    for (double t = 0; t <= 1.0; t += 0.01) {
      const double x = a.x + t * (b.x - a.x);
      const double y = a.y + t * (b.y - a.y);
      EXPECT_FALSE(x > -20 && x<20 && y>-20 && y < 20) << "segment " << i << " crosses tower";
    }
  }
}
