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

#ifndef AEROPACT_SAFETY__GEOFENCE_HPP_
#define AEROPACT_SAFETY__GEOFENCE_HPP_

#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"

namespace aeropact::safety
{

struct StaticZone
{
  std::string id;
  geom::Polygon polygon;
  double floor_m{0.0};
  double ceiling_m{1e9};
};

/**
 * Pre-loaded geofence: operating-area bounds, static no-fly zones and safe landing sites. Loaded
 * once from the world file at configuration time; never updated over the network (I4).
 */
struct Geofence
{
  geom::Bounds bounds;
  std::vector<StaticZone> zones;
  std::vector<geom::Vec3> safe_sites;

  static Geofence load(const std::string & world_yaml);
  static Geofence from_yaml_string(const std::string & yaml);

  bool inside_bounds(const geom::Vec3 & p, double margin) const;
  /// Zone containing p (horizontal polygon and altitude band), or nullptr.
  const StaticZone * zone_at(const geom::Vec3 & p) const;
  const geom::Vec3 * nearest_safe_site(const geom::Vec3 & p) const;
};

}  // namespace aeropact::safety

#endif  // AEROPACT_SAFETY__GEOFENCE_HPP_
