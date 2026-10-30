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

#include "mission.hpp"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>

namespace aeropact::agent
{

std::optional<std::vector<core::Vec3>> build_leg(
  core::RoutePlanner & planner, const LegRequest & req)
{
  auto route = planner.plan(req.from, req.to, req.cruise_alt);
  if (!route) {
    return std::nullopt;
  }
  std::vector<core::Vec3> wps;
  // Take off / climb vertically before moving sideways near the ground.
  if (req.from.z < req.cruise_alt - 3.0) {
    wps.push_back({req.from.x, req.from.y, req.cruise_alt});
  }
  for (std::size_t i = 1; i < route->size(); ++i) {
    wps.push_back((*route)[i]);
  }
  if (wps.empty()) {
    wps.push_back({req.to.x, req.to.y, req.cruise_alt});
  }
  if (std::abs(wps.back().z - req.to.z) > 0.5) {
    wps.push_back(req.to);
  }
  return wps;
}

double cruise_layer(const std::string & drone_id, double base, double spacing, int layers)
{
  int n = 0;
  for (const char c : drone_id) {
    if (std::isdigit(static_cast<unsigned char>(c))) {
      n = n * 10 + (c - '0');
    }
  }
  return base + spacing * static_cast<double>(n % std::max(1, layers));
}

}  // namespace aeropact::agent
