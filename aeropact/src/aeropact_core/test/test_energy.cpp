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

#include "aeropact_core/energy.hpp"

using aeropact::core::EnergyModel;
using aeropact::core::EnergyParams;
using aeropact::core::Vec3;

TEST(Energy, PowerGrowsWithSpeedAndPayload)
{
  EnergyModel m;
  EXPECT_GT(m.power_w(10, 0), m.power_w(0, 0));
  EXPECT_GT(m.power_w(10, 1.5), m.power_w(10, 0));
}

TEST(Energy, HeadwindCostsMoreThanTailwind)
{
  EnergyModel m;
  const Vec3 a{0, 0, 0};
  const Vec3 b{1000, 0, 0};
  const double head = m.soc_for_leg(a, b, 1.0, {-5, 0, 0}, 35, false);
  const double tail = m.soc_for_leg(a, b, 1.0, {5, 0, 0}, 35, false);
  EXPECT_GT(head, tail);
}

TEST(Energy, FeasibilityKeepsPessimisticReserve)
{
  EnergyParams p;
  p.reserve_soc = 0.2;
  p.pessimism = 0.15;
  p.soc_sigma = 0.05;
  EnergyModel m(p);
  EXPECT_TRUE(m.feasible(0.9, 0.3, 0.1));
  // 0.6 - 0.05 - 1.15 * 0.3 = 0.205 >= 0.2
  EXPECT_TRUE(m.feasible(0.6, 0.25, 0.05));
  EXPECT_FALSE(m.feasible(0.5, 0.25, 0.05));
}

TEST(Energy, ConsumptionFactorScalesEstimates)
{
  EnergyModel m;
  const double nominal = m.soc_for_leg({0, 0, 0}, {500, 0, 0}, 1.0, {}, 35, true);
  const double endurance = m.max_endurance_s(0.8);
  m.set_consumption_factor(2.0);
  EXPECT_NEAR(m.soc_for_leg({0, 0, 0}, {500, 0, 0}, 1.0, {}, 35, true), 2.0 * nominal, 1e-12);
  EXPECT_NEAR(m.max_endurance_s(0.8), endurance / 2.0, 1e-6);
}

TEST(Energy, EnduranceIsMonotonic)
{
  EnergyModel m;
  EXPECT_GT(m.max_endurance_s(0.8), m.max_endurance_s(0.4));
  EXPECT_DOUBLE_EQ(m.max_endurance_s(-0.1), 0.0);
}
