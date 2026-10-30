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

#include "aeropact_sim/battery_model.hpp"

using aeropact::sim::BatteryModel;
using aeropact::sim::BatteryParams;

TEST(BatteryModel, FlightDrainsAndChargingRefills)
{
  BatteryModel b(BatteryParams{}, 0.8);
  b.step(60.0, true, {8, 0, 0}, {0, 0, 0}, 1.0, false);
  const double after_flight = b.soc();
  EXPECT_LT(after_flight, 0.8);
  b.step(30.0, false, {0, 0, 0}, {0, 0, 0}, 0.0, true);
  EXPECT_GT(b.soc(), after_flight);
}

TEST(BatteryModel, DrainFactorAndPayloadIncreaseConsumption)
{
  BatteryModel a(BatteryParams{}, 1.0);
  BatteryModel b(BatteryParams{}, 1.0);
  a.step(100.0, true, {8, 0, 0}, {}, 0.0, false);
  b.step(100.0, true, {8, 0, 0}, {}, 2.0, false);
  EXPECT_LT(b.soc(), a.soc());
  BatteryModel c(BatteryParams{}, 1.0);
  c.params().drain_factor = 1.5;
  c.step(100.0, true, {8, 0, 0}, {}, 0.0, false);
  EXPECT_LT(c.soc(), a.soc());
}

TEST(BatteryModel, ClampsAndReportsDepletion)
{
  BatteryModel b(BatteryParams{}, 0.001);
  b.step(600.0, true, {10, 0, 0}, {}, 0.0, false);
  EXPECT_TRUE(b.depleted());
  EXPECT_DOUBLE_EQ(b.soc(), 0.0);
  EXPECT_NEAR(b.voltage(), 13.2, 1e-9);
}
