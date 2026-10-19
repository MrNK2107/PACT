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

#include "aeropact_baselines/global_assignment.hpp"

using aeropact::baselines::assign_greedy;
using aeropact::baselines::IdleDrone;
using aeropact::core::EnergyModel;
using aeropact::core::Task;

namespace
{

Task task(const std::string & id, double x, double y, int priority)
{
  Task t;
  t.task_id = id;
  t.pickup = {0, 0, 0};
  t.drop = {x, y, 0};
  t.priority = static_cast<std::uint8_t>(priority);
  t.deadline = 1000;
  t.weight_kg = 1.0f;
  return t;
}

}  // namespace

TEST(GlobalAssignment, OneTaskPerDroneAndUrgentFirst)
{
  const EnergyModel energy;
  const std::vector<IdleDrone> drones{{"A01", {0, 0, 0}, 0.9, 2.0}, {"A02", {10, 0, 0}, 0.9, 2.0}};
  const std::vector<Task> tasks{task("low", 100, 0, 3), task("urgent", 300, 0, 1),
    task("mid", 120, 0, 2)};
  const auto pairs = assign_greedy(drones, tasks, energy, {}, 38, 0);
  ASSERT_EQ(pairs.size(), 2u);
  EXPECT_EQ(pairs[0].second, "urgent");
  EXPECT_NE(pairs[0].first, pairs[1].first);
  EXPECT_NE(pairs[1].second, "low");
}

TEST(GlobalAssignment, RespectsEnergyAndPayload)
{
  const EnergyModel energy;
  const std::vector<IdleDrone> drones{{"A01", {0, 0, 0}, 0.25, 2.0}};
  EXPECT_TRUE(assign_greedy(drones, {task("t", 800, 0, 1)}, energy, {}, 38, 0).empty());
  const std::vector<IdleDrone> light{{"A01", {0, 0, 0}, 0.9, 0.5}};
  EXPECT_TRUE(assign_greedy(light, {task("t", 100, 0, 1)}, energy, {}, 38, 0).empty());
}
