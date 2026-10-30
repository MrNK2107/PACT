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

#ifndef AEROPACT_BASELINES__GLOBAL_ASSIGNMENT_HPP_
#define AEROPACT_BASELINES__GLOBAL_ASSIGNMENT_HPP_

#include <string>
#include <utility>
#include <vector>

#include "aeropact_core/energy.hpp"
#include "aeropact_core/types.hpp"

namespace aeropact::baselines
{

struct IdleDrone
{
  std::string id;
  core::Vec3 position;
  double soc{1.0};
  double capacity_kg{2.0};
};

/**
 * Global greedy assignment with full information: repeatedly pick the cheapest feasible
 * (drone, task) pair until no feasible pair remains. Cost is flight distance minus a priority
 * bonus plus a deadline-slack term; feasibility uses the same pessimistic energy rule as the
 * agents, so the baseline is not advantaged by ignoring the reserve. Deterministic.
 */
std::vector<std::pair<std::string, std::string>> assign_greedy(
  const std::vector<IdleDrone> & drones, const std::vector<core::Task> & tasks,
  const core::EnergyModel & energy, const core::Vec3 & wind, double cruise_alt, double now);

}  // namespace aeropact::baselines

#endif  // AEROPACT_BASELINES__GLOBAL_ASSIGNMENT_HPP_
