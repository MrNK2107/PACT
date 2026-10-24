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

#include "aeropact_safety/supervisor.hpp"

#include <yaml-cpp/yaml.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace aeropact::safety
{

const char * to_string(Action a)
{
  switch (a) {
    case Action::kNominal: return "NOMINAL";
    case Action::kAvoid: return "AVOID";
    case Action::kHold: return "HOLD";
    case Action::kRtl: return "RTL";
    case Action::kLandNearest: return "LAND_NEAREST";
    case Action::kLandNow: return "LAND_NOW";
    case Action::kDisarmed: return "DISARMED";
    case Action::kAutopilot: return "AUTOPILOT";
  }
  return "UNKNOWN";
}

Action action_from_string(const std::string & s)
{
  if (s == "HOLD") {return Action::kHold;}
  if (s == "RTL") {return Action::kRtl;}
  if (s == "LAND_NEAREST") {return Action::kLandNearest;}
  if (s == "LAND_NOW") {return Action::kLandNow;}
  return Action::kNominal;  // CONTINUE_COMMITTED and unknown values: no intervention
}

namespace
{

SafetyPolicy parse_policy(const YAML::Node & root)
{
  SafetyPolicy p;
  if (const auto c = root["contingencies"]) {
    if (c["geofence_breach"]) {
      p.on_geofence_breach = action_from_string(c["geofence_breach"].as<std::string>());
    }
    if (c["soc_low"]) {p.on_soc_low = action_from_string(c["soc_low"].as<std::string>());}
    if (c["soc_critical"]) {
      p.on_soc_critical = action_from_string(c["soc_critical"].as<std::string>());
    }
    if (c["command_timeout"]) {
      p.on_command_timeout = action_from_string(c["command_timeout"].as<std::string>());
    }
  }
  auto get = [](const YAML::Node & n, const char * key, double & out) {
      if (n && n[key]) {
        out = n[key].as<double>();
      }
    };
  const auto l = root["limits"];
  get(l, "soc_floor", p.soc_floor);
  get(l, "soc_critical", p.soc_critical);
  get(l, "max_altitude_m", p.max_altitude_m);
  get(l, "min_cruise_altitude_m", p.min_cruise_altitude_m);
  get(l, "geofence_margin_m", p.geofence_margin_m);
  get(l, "geofence_lookahead_s", p.geofence_lookahead_s);
  get(l, "max_speed_mps", p.max_speed);
  get(l, "max_climb_mps", p.max_climb);
  get(l, "max_descent_mps", p.max_descent);
  const auto s = root["separation"];
  get(s, "radius_m", p.sep_radius_m);
  get(s, "vertical_m", p.sep_vertical_m);
  get(s, "horizon_s", p.sep_horizon_s);
  get(s, "consider_range_m", p.sep_range_m);
  get(s, "landing_clearance_m", p.landing_clearance_m);
  const auto w = root["watchdog"];
  get(w, "command_timeout_s", p.command_timeout_s);
  get(w, "hold_escalation_s", p.hold_escalation_s);
  const auto r = root["rtl"];
  get(r, "altitude_m", p.rtl_altitude_m);
  get(r, "speed_mps", p.rtl_speed);
  return p;
}

}  // namespace

SafetyPolicy SafetyPolicy::load(const std::string & yaml_path)
{
  return parse_policy(YAML::LoadFile(yaml_path));
}

SafetyPolicy SafetyPolicy::from_yaml_string(const std::string & yaml)
{
  return parse_policy(YAML::Load(yaml));
}

SafetySupervisor::SafetySupervisor(
  SafetyPolicy policy, Geofence fence, std::string self_id, Vec3 home)
: policy_(policy), fence_(std::move(fence)), self_(std::move(self_id)), home_(home) {}

void SafetySupervisor::clear_latch()
{
  latched_ = Action::kNominal;
  latched_target_.reset();
  hold_since_ = -1.0;
}

Vec3 SafetySupervisor::goto_velocity(
  const SafetyInput & in, const Vec3 & target, double speed, bool land) const
{
  const double agl = in.position.z - in.ground_z;
  const double d = geom::dist_xy(in.position, target);
  Vec3 v{0, 0, 0};
  if (d > 2.0) {
    // Far from the site: climb or descend to the transit altitude first, then fly level. On the
    // final approach (within 40 m) reposition level, at least 12 m above the site: climbing back
    // to the transit altitude after every side-step made the approach oscillate (D-28).
    const double transit = d > 40.0 ? std::max(policy_.rtl_altitude_m, target.z + 10.0) :
      std::max(in.position.z, target.z + 12.0);
    const double dz = transit - in.position.z;
    if (std::abs(dz) > 3.0 && agl < transit - 3.0) {
      v.z = std::clamp(dz * 0.8, -policy_.max_descent, policy_.max_climb);
      return v;
    }
    const double s = std::min(speed, std::sqrt(2.0 * 1.5 * d));
    v.x = (target.x - in.position.x) / d * s;
    v.y = (target.y - in.position.y) / d * s;
    v.z = std::clamp(dz * 0.5, -policy_.max_descent, policy_.max_climb);
    return v;
  }
  v.x = (target.x - in.position.x) * 0.5;
  v.y = (target.y - in.position.y) * 0.5;
  if (land) {
    v = land_velocity(in, v);
  }
  return v;
}

Vec3 SafetySupervisor::land_velocity(const SafetyInput & in, const Vec3 & horizontal) const
{
  // Never descend onto an aircraft below, parked or hovering / landing there: side-step until
  // 7 m clear, then descend.
  const double agl = in.position.z - in.ground_z;
  Vec3 v = horizontal;
  Vec3 away{0, 0, 0};
  bool blocked = false;
  for (const auto & c : in.contacts) {
    const double c_agl = in.position.z + c.rel_pos.z - in.ground_z;
    const double h = geom::norm_xy(c.rel_pos);
    const double other_speed = geom::norm(c.rel_vel + in.velocity);
    const bool parked = c_agl < 1.0 && other_speed < 0.5;
    const bool below = c.rel_pos.z < -0.5 && other_speed < 1.5;
    if ((parked || below) && h < 7.0) {
      blocked = true;
      const double n = std::max(h, 0.1);
      away = away - Vec3{c.rel_pos.x / n, c.rel_pos.y / n, 0.0};
      if (h < 0.1) {
        away = away + Vec3{1.0, 0.0, 0.0};  // directly above: pick a deterministic side
      }
    }
  }
  if (blocked) {
    const double n = std::max(geom::norm_xy(away), 1e-6);
    v.x = away.x / n * 2.5;
    v.y = away.y / n * 2.5;
    v.z = 0.0;
    return v;
  }
  v.z = agl > 4.0 ? -policy_.max_descent : -0.6;
  return v;
}

bool SafetySupervisor::site_occupied(const Vec3 & site, const SafetyInput & in) const
{
  // Another aircraft on or low over the site (sensed): parked there, landing or holding.
  for (const auto & c : in.contacts) {
    const Vec3 p = in.position + c.rel_pos;
    if (geom::dist_xy(p, site) < 2.0 * policy_.landing_clearance_m && p.z < site.z + 15.0) {
      return true;
    }
  }
  return false;
}

Vec3 SafetySupervisor::clear_safe_site(const SafetyInput & in) const
{
  const Vec3 * best = nullptr;
  double best_d = std::numeric_limits<double>::infinity();
  for (const auto & s : fence_.safe_sites) {
    const double d = geom::dist_xy(in.position, s);
    if (d < best_d && !site_occupied(s, in)) {
      best_d = d;
      best = &s;
    }
  }
  if (best == nullptr) {
    best = fence_.nearest_safe_site(in.position);  // all occupied: land_velocity side-steps
  }
  return best != nullptr ? *best : in.position;
}

bool SafetySupervisor::conflict(const Vec3 & v, const SafetyInput & in, double & miss) const
{
  miss = 1e9;
  bool any = false;
  for (const auto & c : in.contacts) {
    if (geom::norm(c.rel_pos) > policy_.sep_range_m) {
      continue;
    }
    // Other aircraft velocity in world frame, relative motion against candidate velocity v.
    const Vec3 v_other = c.rel_vel + in.velocity;
    // Aircraft parked on the ground are obstacles for landing (land_velocity), not traffic.
    const double c_agl = in.position.z + c.rel_pos.z - in.ground_z;
    if (c_agl < 1.0 && geom::norm(v_other) < 0.5) {
      continue;
    }
    const Vec3 w = v_other - v;
    const double w2 = geom::dot(w, w);
    double t = 0.0;
    if (w2 > 1e-9) {
      t = std::clamp(-geom::dot(c.rel_pos, w) / w2, 0.0, policy_.sep_horizon_s);
    }
    const Vec3 p = c.rel_pos + w * t;
    const double horizontal = geom::norm_xy(p);
    const double vertical = std::abs(p.z);
    miss = std::min(miss, horizontal);
    if (horizontal < policy_.sep_radius_m && vertical < policy_.sep_vertical_m) {
      any = true;
    }
  }
  return any;
}

Vec3 SafetySupervisor::separation_filter(
  const Vec3 & desired, const SafetyInput & in, bool & modified, double & min_sep) const
{
  modified = false;
  min_sep = 1e9;
  for (const auto & c : in.contacts) {
    min_sep = std::min(min_sep, geom::norm(c.rel_pos));
  }
  double miss = 0.0;
  if (!conflict(desired, in, miss)) {
    return desired;
  }
  // Deterministic candidate search around the desired velocity. Vertical role from the id
  // tie-break, so two aircraft choose complementary manoeuvres without talking.
  const double speed = std::max(geom::norm_xy(desired), 3.0);
  const double heading = std::atan2(desired.y, desired.x);
  std::vector<Vec3> candidates;
  const double angles[] = {0.0, 0.35, -0.35, 0.7, -0.7, 1.05, -1.05, 1.57, -1.57, 2.2, -2.2,
    M_PI};
  const double scales[] = {1.0, 0.6, 0.3};
  for (const double s : scales) {
    for (const double a : angles) {
      // Right-hand turns first (a < 0 is a right turn in ENU).
      const double h = heading - a;
      candidates.push_back({std::cos(h) * speed * s, std::sin(h) * speed * s, desired.z});
    }
  }
  bool climb_first = true;
  for (const auto & c : in.contacts) {
    if (geom::norm(c.rel_pos) < policy_.sep_range_m && c.id < self_) {
      climb_first = false;  // the lower id climbs, the other descends
    }
  }
  const double agl = in.position.z - in.ground_z;
  const bool near_ground = agl < 6.0;
  const double vz = climb_first || near_ground ? policy_.max_climb : -policy_.max_descent;
  candidates.push_back({desired.x * 0.3, desired.y * 0.3, vz});
  candidates.push_back({0, 0, vz});
  if (!near_ground) {
    candidates.push_back({0, 0, -vz});
  }
  candidates.push_back({0, 0, 0});
  if (near_ground) {
    // Close to the ground an escape never descends: hold height or climb.
    for (auto & c : candidates) {
      c.z = std::max(c.z, 0.0);
    }
  }

  const Vec3 * best = nullptr;
  double best_cost = 1e18;
  const Vec3 * least_bad = nullptr;
  double best_miss = -1.0;
  for (const auto & cand : candidates) {
    double m = 0.0;
    const bool bad = conflict(cand, in, m);
    if (!bad) {
      const double cost = geom::norm(cand - desired);
      if (cost < best_cost) {
        best_cost = cost;
        best = &cand;
      }
    } else if (m > best_miss) {
      best_miss = m;
      least_bad = &cand;
    }
  }
  modified = true;
  if (best != nullptr) {
    return *best;
  }
  return least_bad != nullptr ? *least_bad : Vec3{0, 0, vz};
}

void SafetySupervisor::update_discharge(const SafetyInput & in, bool on_ground)
{
  if (!in.battery_valid) {
    return;
  }
  if (last_soc_t_ >= 0.0 && in.soc != last_soc_) {
    const double dt = in.now - last_soc_t_;
    const double rate = (last_soc_ - in.soc) / std::max(dt, 1e-3);
    if (!on_ground && rate > 0.0 && dt > 0.05) {
      discharge_rate_ = discharge_samples_ == 0 ? rate : 0.7 * discharge_rate_ + 0.3 * rate;
      ++discharge_samples_;
    }
  }
  if (last_soc_t_ < 0.0 || in.soc != last_soc_) {
    last_soc_ = in.soc;
    last_soc_t_ = in.now;
  }
}

SafetyOutput SafetySupervisor::step(const SafetyInput & in)
{
  SafetyOutput out;
  const double agl = in.position.z - in.ground_z;
  // With an autopilot, its land detector is authoritative: the estimated height above a pad can
  // be off by a few decimetres (baro / GNSS), which a fixed height threshold cannot absorb.
  const bool on_ground = std::abs(in.velocity.z) < 0.35 &&
    (agl < 0.35 || (in.autopilot_present && in.autopilot_landed));
  out.command_fresh = in.mission_velocity.has_value() &&
    in.now - in.mission_stamp <= policy_.command_timeout_s;

  // ---- arming ----
  // After a contingency landing the vehicle re-arms only on a fresh request (false -> true), so
  // a stale request cannot launch it straight back into the situation that grounded it.
  if (!in.arm_request) {
    need_fresh_arm_ = false;
  }
  if (!armed_ && in.arm_request && !need_fresh_arm_ &&
    !(in.battery_valid && in.soc < policy_.soc_floor))
  {
    armed_ = true;
    clear_latch();
  }
  if (!armed_) {
    out.action = Action::kDisarmed;
    out.reason = "disarmed";
    out.armed = false;
    return out;
  }

  // ---- contingency triggers (latched until touchdown) ----
  const Vec3 ahead = in.position + in.velocity * policy_.geofence_lookahead_s;
  const bool fence_breach = !fence_.inside_bounds(ahead, policy_.geofence_margin_m) ||
    fence_.zone_at(ahead) != nullptr || in.position.z > policy_.max_altitude_m;
  out.geofence_ok = !fence_breach;

  auto escalate = [&](Action a, const char * why) {
      if (static_cast<int>(a) > static_cast<int>(latched_)) {
        latched_ = a;
        latched_target_.reset();
        out.reason = why;
      }
    };
  // The autopilot's own failsafes (or a remote pilot) outrank everything here: never contest them.
  if (in.autopilot_present && in.autopilot_override) {
    escalate(Action::kAutopilot, "autopilot_override");
  }
  // Endurance: measured discharge rate -> time to empty, compared with the time needed to land
  // here and to reach the nearest safe site. Fixed SOC floors remain as a backstop.
  update_discharge(in, on_ground);
  if (in.battery_valid && !on_ground && discharge_samples_ >= 3 && discharge_rate_ > 1e-6) {
    const double t_empty = in.soc / discharge_rate_;
    const double t_land_here = agl / policy_.max_descent + 5.0;
    out.endurance_s = t_empty;
    if (t_empty < 1.3 * t_land_here + 3.0) {
      escalate(Action::kLandNow, "endurance_critical");
    } else if (const Vec3 * site = fence_.nearest_safe_site(in.position)) {
      const double transit = std::max(policy_.rtl_altitude_m, site->z + 10.0);
      const double t_site = geom::dist_xy(in.position, *site) / policy_.rtl_speed +
        std::abs(transit - in.position.z) / policy_.max_climb + transit / policy_.max_descent +
        10.0;
      if (t_empty < 1.5 * t_site) {
        escalate(policy_.on_soc_low, "endurance_low");
      }
    }
  }
  if (in.battery_valid && in.soc < policy_.soc_critical) {
    escalate(policy_.on_soc_critical, "soc_critical");
  } else if (in.battery_valid && in.soc < policy_.soc_floor && !on_ground) {
    escalate(policy_.on_soc_low, "soc_low");
  }
  if (fence_breach && !on_ground) {
    escalate(policy_.on_geofence_breach, "geofence_breach");
  }
  if (!out.command_fresh && !on_ground && latched_ == Action::kNominal) {
    if (hold_since_ < 0.0) {
      hold_since_ = in.now;
    }
    if (in.now - hold_since_ > policy_.hold_escalation_s) {
      escalate(Action::kRtl, "command_timeout_escalation");
    }
  } else if (out.command_fresh) {
    hold_since_ = -1.0;
  }

  // ---- velocity selection ----
  Vec3 v{0, 0, 0};
  switch (latched_) {
    case Action::kAutopilot:
      v = {0, 0, 0};  // not forwarded: the autopilot flies the vehicle
      out.veto = true;
      break;
    case Action::kLandNow:
      v = land_velocity(in, {0, 0, 0});
      out.veto = true;
      break;
    case Action::kLandNearest: {
        // The nearest safe site no sensed aircraft occupies; re-selected (at most every 5 s) when
        // another aircraft takes it first, rather than queueing above it (D-28).
        if (!latched_target_ ||
          (site_occupied(*latched_target_, in) && in.now - last_reselect_ >= 5.0))
        {
          latched_target_ = clear_safe_site(in);
          last_reselect_ = in.now;
        }
        v = goto_velocity(in, *latched_target_, policy_.rtl_speed, true);
        out.veto = true;
        break;
      }
    case Action::kRtl:
      if (!latched_target_ ||
        (site_occupied(*latched_target_, in) && in.now - last_reselect_ >= 5.0))
      {
        latched_target_ = site_occupied(home_, in) ? clear_safe_site(in) : home_;
        last_reselect_ = in.now;
      }
      v = goto_velocity(in, *latched_target_, policy_.rtl_speed, true);
      out.veto = true;
      break;
    default:
      if (hold_since_ >= 0.0 && !out.command_fresh) {
        v = {0, 0, 0};
        out.veto = true;
        if (out.reason.empty()) {
          out.reason = "command_timeout";
        }
      } else if (in.mission_velocity) {
        v = *in.mission_velocity;
      }
      break;
  }
  out.action = latched_ != Action::kNominal ? latched_ :
    (out.veto ? policy_.on_command_timeout : Action::kNominal);

  // ---- envelope limits ----
  v = geom::clamp_xy(v, policy_.max_speed);
  v.z = std::clamp(v.z, -policy_.max_descent, policy_.max_climb);
  if (in.position.z >= policy_.max_altitude_m && v.z > 0.0) {
    v.z = 0.0;
  }

  // ---- occupied landing spot (every mode we fly) ----
  // The separation filter treats aircraft parked on the ground as obstacles, not traffic, and
  // contingency landings side-step them (land_velocity); a mission descent must not land on one
  // either, whatever the mission layer believes about the pad. Hold height above it instead.
  if (!on_ground && latched_ != Action::kAutopilot && v.z < 0.0 && agl < 12.0) {
    for (const auto & c : in.contacts) {
      const double c_agl = in.position.z + c.rel_pos.z - in.ground_z;
      if (c_agl < 1.0 && geom::norm(c.rel_vel + in.velocity) < 0.5 &&
        geom::norm_xy(c.rel_pos) < policy_.landing_clearance_m)
      {
        v.z = 0.0;
        out.veto = true;
        avoid_until_ = in.now + 1.0;
        out.reason = "occupied_landing_spot";
        break;
      }
    }
  }

  // ---- separation reflex (always on while airborne) ----
  if (!on_ground && latched_ != Action::kAutopilot) {
    bool modified = false;
    double min_sep = 1e9;
    const Vec3 filtered = separation_filter(v, in, modified, min_sep);
    out.min_separation = min_sep;
    if (modified) {
      v = filtered;
      out.veto = true;
      avoid_until_ = in.now + 1.0;
    }
    if (in.now < avoid_until_ && out.action == Action::kNominal) {
      out.action = Action::kAvoid;  // reported with 1 s hysteresis; filtering is per step
      if (out.reason.empty()) {
        out.reason = "separation";
      }
    }
  } else {
    for (const auto & c : in.contacts) {
      out.min_separation = std::min(out.min_separation, geom::norm(c.rel_pos));
    }
  }

  // ---- touchdown handling: a contingency landing ends disarmed ----
  const bool landing_latched = latched_ == Action::kLandNow || latched_ == Action::kLandNearest ||
    latched_ == Action::kRtl || latched_ == Action::kAutopilot;
  if (on_ground && (landing_latched || !in.arm_request)) {
    if (touchdown_since_ < 0.0) {
      touchdown_since_ = in.now;
    }
    if (in.now - touchdown_since_ > 1.0) {
      armed_ = false;
      need_fresh_arm_ = landing_latched;
      out.reason = landing_latched ? "contingency_landing_complete" : "landed";
      latched_ = Action::kNominal;  // the contingency is complete
      latched_target_.reset();
      v = {0, 0, 0};
    }
  } else {
    touchdown_since_ = -1.0;
  }
  out.velocity = v;
  out.armed = armed_;
  if (!armed_) {
    out.action = Action::kDisarmed;
  }
  return out;
}

}  // namespace aeropact::safety
