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

#ifndef AEROPACT_CORE__WORLD_MODEL_HPP_
#define AEROPACT_CORE__WORLD_MODEL_HPP_

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "aeropact_core/types.hpp"
#include "aeropact_geometry/geometry.hpp"

namespace aeropact::core
{

struct Pad
{
  std::string id;
  std::string depot_id;  ///< empty for public pads
  Vec3 position;
};

struct Depot
{
  std::string id;
  Vec3 position;   ///< depot building centre
  Vec3 handoff;    ///< parcel hand-off reference point (first bay)
  std::vector<Vec3> bays;  ///< hand-off bays, reserved one drone at a time
  std::vector<std::string> pad_ids;
};

struct DropPoint
{
  std::string id;
  Vec3 position;
  std::string cluster;
  std::string kind;
  double weight{1.0};
};

struct NoFlyZone
{
  std::string id;
  geom::Polygon polygon;
  double floor_m{0.0};
  double ceiling_m{1e9};
  bool active{true};
  std::string reason;
};

struct Building
{
  std::string id;
  geom::Polygon footprint;
  double height_m{10.0};
};

/**
 * Static description of the operating area, loaded from the world YAML produced by the world
 * generator (aeropact_sim). Shared by planners; dynamic restrictions are applied with
 * `set_restriction`.
 */
class WorldModel
{
public:
  static WorldModel load(const std::string & yaml_path);
  static WorldModel from_yaml_string(const std::string & yaml);

  std::string name;
  geom::Bounds bounds;
  double max_altitude_m{120.0};
  double shard_size_m{150.0};
  Vec3 wind;  ///< mean wind vector, m/s (energy only, assumption T11)
  std::vector<Depot> depots;
  std::vector<Pad> pads;
  std::vector<DropPoint> drop_points;
  std::vector<NoFlyZone> no_fly;
  std::vector<Building> buildings;

  const Depot * depot(const std::string & id) const;
  const Pad * pad(const std::string & id) const;
  const DropPoint * drop_point(const std::string & id) const;
  /// Nearest pad by horizontal distance; nullptr when there are none.
  const Pad * nearest_pad(const Vec3 & p) const;
  const Depot * nearest_depot(const Vec3 & p) const;

  /// Insert or replace a dynamic restriction (NOTAM). Returns true when anything changed.
  bool set_restriction(const NoFlyZone & zone);
  /// True when (x, y, z) is inside an active no-fly zone.
  bool in_no_fly(double x, double y, double z) const;
  /// Bumped whenever no-fly zones change, so planners can cache rasters.
  unsigned airspace_version() const {return airspace_version_;}

private:
  unsigned airspace_version_{0};
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__WORLD_MODEL_HPP_
