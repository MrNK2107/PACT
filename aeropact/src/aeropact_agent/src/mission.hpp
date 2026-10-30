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

#ifndef MISSION_HPP_
#define MISSION_HPP_

#include <optional>
#include <string>
#include <vector>

#include "aeropact_core/route_planner.hpp"
#include "aeropact_core/types.hpp"

namespace aeropact::agent
{

/// How a flight leg ends.
enum class LegEnd { kHover, kLand };

struct LegRequest
{
  core::Vec3 from;
  core::Vec3 to;          ///< final point (pad surface for landing, hover point otherwise)
  double cruise_alt{35.0};
  LegEnd end{LegEnd::kHover};
};

/**
 * Builds the 3-D waypoint list of a leg: vertical climb to the cruise layer when needed, the
 * planner's horizontal route on that layer, then the vertical segment to the end point.
 * Returns nullopt when no route exists at the layer.
 */
std::optional<std::vector<core::Vec3>> build_leg(
  core::RoutePlanner & planner, const LegRequest & req);

/// Picks the vehicle's cruise layer: base + (index mod layers) * spacing.
double cruise_layer(const std::string & drone_id, double base, double spacing, int layers);

}  // namespace aeropact::agent

#endif  // MISSION_HPP_
