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

#include "aeropact_baselines/global_assignment.hpp"

#include <limits>

namespace aeropact::baselines
{

std::vector<std::pair<std::string, std::string>> assign_greedy(
  const std::vector<IdleDrone> & drones, const std::vector<core::Task> & tasks,
  const core::EnergyModel & energy, const core::Vec3 & wind, double cruise_alt, double now)
{
  std::vector<std::pair<std::string, std::string>> out;
  std::vector<bool> drone_used(drones.size(), false);
  std::vector<bool> task_used(tasks.size(), false);
  while (true) {
    double best = std::numeric_limits<double>::infinity();
    std::size_t bi = drones.size();
    std::size_t bj = tasks.size();
    for (std::size_t i = 0; i < drones.size(); ++i) {
      if (drone_used[i]) {
        continue;
      }
      for (std::size_t j = 0; j < tasks.size(); ++j) {
        if (task_used[j]) {
          continue;
        }
        const auto & d = drones[i];
        const auto & t = tasks[j];
        if (t.weight_kg > d.capacity_kg) {
          continue;
        }
        const double need = energy.soc_for_leg(d.position, t.pickup, 0.0, wind, cruise_alt, true) +
          energy.soc_for_leg(t.pickup, t.drop, t.weight_kg, wind, cruise_alt, true) +
          energy.soc_for_hover(30.0, t.weight_kg);
        if (!energy.feasible(d.soc, need, 0.03)) {
          continue;
        }
        const double dist = geom::dist_xy(d.position, t.pickup) + geom::dist_xy(t.pickup, t.drop);
        const double eta = now + dist / energy.params().cruise_speed;
        const double cost = dist - 400.0 * (3 - t.priority) + 0.5 * (eta - t.deadline);
        if (cost < best) {
          best = cost;
          bi = i;
          bj = j;
        }
      }
    }
    if (bi == drones.size()) {
      break;
    }
    drone_used[bi] = true;
    task_used[bj] = true;
    out.emplace_back(drones[bi].id, tasks[bj].task_id);
  }
  return out;
}

}  // namespace aeropact::baselines
