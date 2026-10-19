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

#ifndef AEROPACT_CORE__ROUTE_PLANNER_HPP_
#define AEROPACT_CORE__ROUTE_PLANNER_HPP_

#include <cstdint>
#include <optional>
#include <vector>

#include "aeropact_core/types.hpp"
#include "aeropact_core/world_model.hpp"

namespace aeropact::core
{

struct PlannerConfig
{
  double cell_m{10.0};
  double inflate_m{12.0};           ///< clearance kept from no-fly zones and buildings
  double building_clearance_m{8.0};  ///< a building blocks a layer below height + clearance
  double boundary_margin_m{15.0};
};

/**
 * 2.5-D route planner: 8-connected A* on a raster of the operating area at one cruise altitude,
 * followed by line-of-sight shortcutting. Obstacles are active no-fly zones whose altitude band
 * covers the layer and buildings too tall for it, inflated by `inflate_m`. Rasters are cached per
 * (altitude, airspace version). Deterministic: ties broken by cell index.
 */
class RoutePlanner
{
public:
  explicit RoutePlanner(const WorldModel & world, PlannerConfig config = {});

  /// Horizontal route at `cruise_alt` from `from` to `to` (both projected to the layer).
  /// Returns waypoints including both endpoints, or nullopt if no route exists.
  std::optional<std::vector<Vec3>> plan(const Vec3 & from, const Vec3 & to, double cruise_alt);

  /// True when the straight segment at `alt` stays clear of obstacles.
  bool segment_clear(const Vec3 & a, const Vec3 & b, double alt);

  static double length(const std::vector<Vec3> & path);

private:
  struct Raster
  {
    double alt{0.0};
    unsigned airspace_version{0};
    int nx{0};
    int ny{0};
    std::vector<std::uint8_t> blocked;  ///< 0 free, 1 inflation margin, 2 obstacle
  };

  const Raster & raster(double alt);
  bool cell_blocked(const Raster & r, int ix, int iy) const;
  std::uint8_t cell_level(const Raster & r, int ix, int iy) const;
  bool line_clear(const Raster & r, double ax, double ay, double bx, double by) const;
  void to_cell(double x, double y, int & ix, int & iy) const;
  void cell_centre(int ix, int iy, double & x, double & y) const;

  const WorldModel & world_;
  PlannerConfig config_;
  std::vector<Raster> cache_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__ROUTE_PLANNER_HPP_
