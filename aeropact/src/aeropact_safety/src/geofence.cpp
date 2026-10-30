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

#include "aeropact_safety/geofence.hpp"

#include <yaml-cpp/yaml.h>

#include <limits>
#include <stdexcept>

namespace aeropact::safety
{
namespace
{

Geofence parse(const YAML::Node & in)
{
  const YAML::Node root = in["world"] ? in["world"] : in;
  Geofence g;
  const auto b = root["bounds"];
  if (!b) {
    throw std::runtime_error("geofence: world file has no bounds");
  }
  g.bounds = {b["min_x"].as<double>(), b["min_y"].as<double>(), b["max_x"].as<double>(),
    b["max_y"].as<double>()};
  for (const auto & z : root["no_fly"]) {
    // Only zones active at load time and not marked dynamic belong to the static geofence.
    if ((z["active"] && !z["active"].as<bool>()) || (z["dynamic"] && z["dynamic"].as<bool>())) {
      continue;
    }
    StaticZone sz;
    sz.id = z["id"].as<std::string>();
    for (const auto & v : z["polygon"]) {
      sz.polygon.push_back({v[0].as<double>(), v[1].as<double>()});
    }
    sz.floor_m = z["floor_m"] ? z["floor_m"].as<double>() : 0.0;
    sz.ceiling_m = z["ceiling_m"] ? z["ceiling_m"].as<double>() : 1e9;
    g.zones.push_back(sz);
  }
  auto add_site = [&g](const YAML::Node & p) {
      const auto pos = p["position"];
      g.safe_sites.push_back({pos[0].as<double>(), pos[1].as<double>(),
          pos.size() > 2 ? pos[2].as<double>() : 0.0});
    };
  for (const auto & d : root["depots"]) {
    for (const auto & p : d["pads"]) {
      add_site(p);
    }
  }
  for (const auto & p : root["public_pads"]) {
    add_site(p);
  }
  for (const auto & s : root["safe_sites"]) {
    add_site(s);
  }
  return g;
}

}  // namespace

Geofence Geofence::load(const std::string & world_yaml)
{
  return parse(YAML::LoadFile(world_yaml));
}

Geofence Geofence::from_yaml_string(const std::string & yaml)
{
  return parse(YAML::Load(yaml));
}

bool Geofence::inside_bounds(const geom::Vec3 & p, double margin) const
{
  return bounds.contains(p.x, p.y, margin);
}

const StaticZone * Geofence::zone_at(const geom::Vec3 & p) const
{
  for (const auto & z : zones) {
    if (p.z >= z.floor_m && p.z <= z.ceiling_m && geom::contains(z.polygon, p.x, p.y)) {
      return &z;
    }
  }
  return nullptr;
}

const geom::Vec3 * Geofence::nearest_safe_site(const geom::Vec3 & p) const
{
  const geom::Vec3 * best = nullptr;
  double best_d = std::numeric_limits<double>::infinity();
  for (const auto & s : safe_sites) {
    const double d = geom::dist_xy(p, s);
    if (d < best_d) {
      best_d = d;
      best = &s;
    }
  }
  return best;
}

}  // namespace aeropact::safety
