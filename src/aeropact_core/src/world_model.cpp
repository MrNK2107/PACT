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

#include "aeropact_core/world_model.hpp"

#include <yaml-cpp/yaml.h>

#include <cmath>
#include <limits>
#include <stdexcept>

namespace aeropact::core
{
namespace
{

Vec3 vec3(const YAML::Node & n)
{
  if (!n || !n.IsSequence() || n.size() < 2) {
    throw std::runtime_error("world yaml: expected [x, y] or [x, y, z]");
  }
  return {n[0].as<double>(), n[1].as<double>(), n.size() > 2 ? n[2].as<double>() : 0.0};
}

geom::Polygon polygon(const YAML::Node & n)
{
  geom::Polygon p;
  for (const auto & v : n) {
    p.push_back({v[0].as<double>(), v[1].as<double>()});
  }
  return p;
}

WorldModel parse(const YAML::Node & root_in)
{
  const YAML::Node root = root_in["world"] ? root_in["world"] : root_in;
  WorldModel w;
  w.name = root["name"] ? root["name"].as<std::string>() : "world";
  const auto b = root["bounds"];
  if (!b) {
    throw std::runtime_error("world yaml: missing bounds");
  }
  w.bounds = {b["min_x"].as<double>(), b["min_y"].as<double>(), b["max_x"].as<double>(),
    b["max_y"].as<double>()};
  w.max_altitude_m = root["max_altitude_m"] ? root["max_altitude_m"].as<double>() : 120.0;
  w.shard_size_m = root["shard_size_m"] ? root["shard_size_m"].as<double>() : 150.0;
  if (root["wind"]) {
    const double speed = root["wind"]["mean_mps"].as<double>(0.0);
    const double dir = root["wind"]["dir_deg"].as<double>(0.0) * M_PI / 180.0;
    // dir_deg is the direction the wind blows towards, measured from east, counter-clockwise.
    w.wind = {speed * std::cos(dir), speed * std::sin(dir), 0.0};
  }
  for (const auto & d : root["depots"]) {
    Depot depot;
    depot.id = d["id"].as<std::string>();
    depot.position = vec3(d["position"]);
    depot.handoff = d["handoff"] ? vec3(d["handoff"]) : depot.position;
    for (const auto & bay : d["bays"]) {
      depot.bays.push_back(vec3(bay));
    }
    if (depot.bays.empty()) {
      depot.bays.push_back(depot.handoff);
    }
    for (const auto & p : d["pads"]) {
      Pad pad;
      pad.id = p["id"].as<std::string>();
      pad.depot_id = depot.id;
      pad.position = vec3(p["position"]);
      depot.pad_ids.push_back(pad.id);
      w.pads.push_back(pad);
    }
    w.depots.push_back(depot);
  }
  for (const auto & p : root["public_pads"]) {
    Pad pad;
    pad.id = p["id"].as<std::string>();
    pad.position = vec3(p["position"]);
    w.pads.push_back(pad);
  }
  for (const auto & d : root["drop_points"]) {
    DropPoint dp;
    dp.id = d["id"].as<std::string>();
    dp.position = vec3(d["position"]);
    dp.cluster = d["cluster"] ? d["cluster"].as<std::string>() : "";
    dp.kind = d["kind"] ? d["kind"].as<std::string>() : "residential";
    dp.weight = d["weight"] ? d["weight"].as<double>() : 1.0;
    w.drop_points.push_back(dp);
  }
  for (const auto & z : root["no_fly"]) {
    NoFlyZone nz;
    nz.id = z["id"].as<std::string>();
    nz.polygon = polygon(z["polygon"]);
    nz.floor_m = z["floor_m"] ? z["floor_m"].as<double>() : 0.0;
    nz.ceiling_m = z["ceiling_m"] ? z["ceiling_m"].as<double>() : 1e9;
    nz.active = z["active"] ? z["active"].as<bool>() : true;
    nz.reason = z["reason"] ? z["reason"].as<std::string>() : "";
    w.no_fly.push_back(nz);
  }
  for (const auto & bl : root["buildings"]) {
    Building bd;
    bd.id = bl["id"].as<std::string>();
    bd.footprint = polygon(bl["footprint"]);
    bd.height_m = bl["height_m"].as<double>();
    w.buildings.push_back(bd);
  }
  return w;
}

}  // namespace

WorldModel WorldModel::load(const std::string & yaml_path)
{
  return parse(YAML::LoadFile(yaml_path));
}

WorldModel WorldModel::from_yaml_string(const std::string & yaml)
{
  return parse(YAML::Load(yaml));
}

const Depot * WorldModel::depot(const std::string & id) const
{
  for (const auto & d : depots) {
    if (d.id == id) {
      return &d;
    }
  }
  return nullptr;
}

const Pad * WorldModel::pad(const std::string & id) const
{
  for (const auto & p : pads) {
    if (p.id == id) {
      return &p;
    }
  }
  return nullptr;
}

const DropPoint * WorldModel::drop_point(const std::string & id) const
{
  for (const auto & d : drop_points) {
    if (d.id == id) {
      return &d;
    }
  }
  return nullptr;
}

const Pad * WorldModel::nearest_pad(const Vec3 & p) const
{
  const Pad * best = nullptr;
  double best_d = std::numeric_limits<double>::infinity();
  for (const auto & pad : pads) {
    const double d = geom::dist_xy(p, pad.position);
    if (d < best_d) {
      best_d = d;
      best = &pad;
    }
  }
  return best;
}

const Depot * WorldModel::nearest_depot(const Vec3 & p) const
{
  const Depot * best = nullptr;
  double best_d = std::numeric_limits<double>::infinity();
  for (const auto & d : depots) {
    const double dd = geom::dist_xy(p, d.position);
    if (dd < best_d) {
      best_d = dd;
      best = &d;
    }
  }
  return best;
}

bool WorldModel::set_restriction(const NoFlyZone & zone)
{
  for (auto & z : no_fly) {
    if (z.id == zone.id) {
      const bool same = z.active == zone.active && z.floor_m == zone.floor_m &&
        z.ceiling_m == zone.ceiling_m && z.polygon.size() == zone.polygon.size();
      if (same) {
        return false;
      }
      z = zone;
      ++airspace_version_;
      return true;
    }
  }
  no_fly.push_back(zone);
  ++airspace_version_;
  return true;
}

bool WorldModel::in_no_fly(double x, double y, double z) const
{
  for (const auto & nz : no_fly) {
    if (nz.active && z >= nz.floor_m && z <= nz.ceiling_m && geom::contains(nz.polygon, x, y)) {
      return true;
    }
  }
  return false;
}

}  // namespace aeropact::core
