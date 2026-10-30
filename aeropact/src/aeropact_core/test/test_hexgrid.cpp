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

#include "aeropact_core/hexgrid.hpp"

using aeropact::core::HexGrid;

TEST(HexGrid, CentreMapsToItsOwnCell)
{
  HexGrid g(150.0);
  for (int q = -5; q <= 5; ++q) {
    for (int r = -5; r <= 5; ++r) {
      const auto c = g.center(q, r);
      EXPECT_EQ(g.shard_of(c.x, c.y), HexGrid::id(q, r));
    }
  }
}

TEST(HexGrid, NearbyPointsShareCellAndIdsParse)
{
  HexGrid g(150.0);
  std::mt19937_64 rng(3);
  std::uniform_real_distribution<double> u(-1000, 1000);
  for (int i = 0; i < 1000; ++i) {
    const double x = u(rng);
    const double y = u(rng);
    int q = 0;
    int r = 0;
    ASSERT_TRUE(HexGrid::parse(g.shard_of(x, y), q, r));
    const auto c = g.center(q, r);
    // Every point lies within the circumradius of its cell centre.
    EXPECT_LE(std::hypot(x - c.x, y - c.y), 150.0 + 1e-6);
  }
}
