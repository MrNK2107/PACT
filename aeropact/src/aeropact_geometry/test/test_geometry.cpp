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

#include "aeropact_geometry/geometry.hpp"

using aeropact::geom::Polygon;
using aeropact::geom::Vec2;
using aeropact::geom::Vec3;

TEST(Geometry, PointInPolygon)
{
  const Polygon square{{0, 0}, {10, 0}, {10, 10}, {0, 10}};
  EXPECT_TRUE(aeropact::geom::contains(square, 5, 5));
  EXPECT_FALSE(aeropact::geom::contains(square, 15, 5));
  EXPECT_FALSE(aeropact::geom::contains(square, -1, -1));
}

TEST(Geometry, DistanceToPolygon)
{
  const Polygon square{{0, 0}, {10, 0}, {10, 10}, {0, 10}};
  EXPECT_DOUBLE_EQ(aeropact::geom::distance_to_polygon(square, 5, 5), 0.0);
  EXPECT_NEAR(aeropact::geom::distance_to_polygon(square, 13, 5), 3.0, 1e-9);
  EXPECT_NEAR(aeropact::geom::distance_to_polygon(square, 13, 14), 5.0, 1e-9);
}

TEST(Geometry, SegmentPolygonIntersection)
{
  const Polygon square{{0, 0}, {10, 0}, {10, 10}, {0, 10}};
  EXPECT_TRUE(aeropact::geom::segment_intersects_polygon({-5, 5}, {15, 5}, square));
  EXPECT_FALSE(aeropact::geom::segment_intersects_polygon({-5, -5}, {-5, 15}, square));
  EXPECT_TRUE(aeropact::geom::segment_intersects_polygon({5, 5}, {50, 50}, square));
}

TEST(Geometry, ClampAndWrap)
{
  const Vec3 v{3, 4, 12};
  const Vec3 c = aeropact::geom::clamp_xy(v, 2.5);
  EXPECT_NEAR(aeropact::geom::norm_xy(c), 2.5, 1e-12);
  EXPECT_DOUBLE_EQ(c.z, 12.0);
  EXPECT_NEAR(aeropact::geom::norm(aeropact::geom::clamp_norm(v, 1.0)), 1.0, 1e-12);
  EXPECT_NEAR(aeropact::geom::wrap_angle(3 * M_PI), M_PI, 1e-12);
  EXPECT_NEAR(aeropact::geom::wrap_angle(-3 * M_PI / 2), M_PI / 2, 1e-12);
}

TEST(Geometry, CirclePolygonContainsCentre)
{
  const Polygon c = aeropact::geom::circle_polygon(100, -50, 20, 24);
  EXPECT_EQ(c.size(), 24u);
  EXPECT_TRUE(aeropact::geom::contains(c, 100, -50));
  EXPECT_FALSE(aeropact::geom::contains(c, 125, -50));
}
