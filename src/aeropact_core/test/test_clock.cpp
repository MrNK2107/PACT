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

#include "aeropact_core/clock.hpp"
#include "aeropact_core/task_ids.hpp"

using aeropact::core::HybridLogicalClock;
using aeropact::core::LocalClock;

TEST(LocalClock, DriftsAtConfiguredRate)
{
  LocalClock c(10000.0, 5.0);  // +1 %
  EXPECT_DOUBLE_EQ(c.now(100.0), 5.0);
  EXPECT_NEAR(c.now(200.0), 5.0 + 101.0, 1e-9);
}

TEST(LocalClock, ChangingDriftStaysContinuousAndMonotonic)
{
  LocalClock c(0.0, 0.0);
  c.now(0.0);
  const double before = c.now(50.0);
  c.set_drift_ppm(-10000.0, 50.0);
  EXPECT_NEAR(c.now(50.0), before, 1e-9);
  EXPECT_NEAR(c.now(150.0), before + 99.0, 1e-9);
  double last = c.now(150.0);
  for (double t = 150.0; t < 160.0; t += 0.01) {
    const double v = c.now(t);
    EXPECT_GE(v, last);
    last = v;
  }
}

TEST(TaskIds, HlcIsStrictlyIncreasingAndIdsFormatted)
{
  HybridLogicalClock h;
  const auto a = h.tick(1.0);
  const auto b = h.tick(1.0);
  EXPECT_GT(b, a);
  h.observe(5000000);
  EXPECT_GT(h.tick(1.0), 5000000u);
  EXPECT_EQ(aeropact::core::make_task_id("D1", 123, 0xab12), "D1:00000123:ab12");
}
