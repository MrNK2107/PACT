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

#ifndef AEROPACT_SAFETY__SUPERVISOR_HPP_
#define AEROPACT_SAFETY__SUPERVISOR_HPP_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"
#include "aeropact_safety/geofence.hpp"

namespace aeropact::safety
{

using geom::Vec3;

/// Values match aeropact_interfaces/msg/SafetyStatus ACTION_*.
enum class Action : std::uint8_t
{
  kNominal = 0,
  kAvoid = 1,
  kHold = 2,
  kRtl = 3,
  kLandNearest = 4,
  kLandNow = 5,
  kDisarmed = 6,
  kAutopilot = 7,  ///< the autopilot took over (its failsafe, a pilot, a GCS); stand down
};
const char * to_string(Action a);
Action action_from_string(const std::string & s);

struct SafetyPolicy
{
  Action on_geofence_breach{Action::kRtl};
  Action on_soc_low{Action::kLandNearest};
  Action on_soc_critical{Action::kLandNow};
  Action on_command_timeout{Action::kHold};
  double soc_floor{0.10};
  double soc_critical{0.05};
  double max_altitude_m{110.0};
  double min_cruise_altitude_m{12.0};
  double geofence_margin_m{10.0};
  double geofence_lookahead_s{2.0};
  double max_speed{14.0};
  double max_climb{3.0};
  double max_descent{3.0};
  double sep_radius_m{9.0};
  double sep_vertical_m{5.0};
  double sep_horizon_s{6.0};
  double sep_range_m{70.0};
  double landing_clearance_m{3.0};  ///< no descent within this radius above a parked aircraft
  double command_timeout_s{1.0};
  double hold_escalation_s{20.0};
  double rtl_altitude_m{60.0};
  double rtl_speed{8.0};

  static SafetyPolicy load(const std::string & yaml_path);
  static SafetyPolicy from_yaml_string(const std::string & yaml);
};

struct Contact
{
  std::string id;
  Vec3 rel_pos;   ///< other - own, world frame
  Vec3 rel_vel;   ///< other - own, world frame
};

struct SafetyInput
{
  double now{0.0};
  Vec3 position;
  Vec3 velocity;
  double soc{1.0};
  bool battery_valid{false};
  std::vector<Contact> contacts;
  std::optional<Vec3> mission_velocity;  ///< latest mission command, world frame
  double mission_stamp{-1e9};            ///< time it was received
  bool arm_request{false};
  double ground_z{0.0};                  ///< local ground height below the vehicle
  // Autopilot link (absent on backends where the supervisor drives the vehicle directly).
  bool autopilot_present{false};
  bool autopilot_override{false};        ///< the autopilot flies the vehicle, not the fleet
  bool autopilot_landed{false};          ///< the autopilot's land detector
};

struct SafetyOutput
{
  Vec3 velocity;           ///< world-frame velocity setpoint to the flight controller
  Action action{Action::kNominal};
  std::string reason;
  bool veto{false};        ///< the mission command was replaced or modified
  bool armed{false};
  bool geofence_ok{true};
  bool command_fresh{false};
  double min_separation{1e9};
  double endurance_s{1e9};  ///< time to empty at the measured discharge rate
};

/**
 * Safety supervisor decision logic (03 section 3.10). Runs every control step with local inputs
 * only. Precedence, highest first:
 *   critical SOC (land now) > low SOC (land at nearest safe site) > geofence breach >
 *   command watchdog (hold, then escalate to RTL) > mission command;
 * the separation reflex filters whatever velocity results, in every mode except disarmed.
 * Latched contingencies (RTL, landing) persist until touchdown; touchdown disarms.
 * Above all of them, an autopilot takeover (AUTOPILOT) latches: the supervisor never contests
 * the flight controller's own failsafes and stands down until the autopilot reports landed.
 */
class SafetySupervisor
{
public:
  SafetySupervisor(SafetyPolicy policy, Geofence fence, std::string self_id, Vec3 home);

  SafetyOutput step(const SafetyInput & in);

  Action latched() const {return latched_;}
  bool armed() const {return armed_;}
  const SafetyPolicy & policy() const {return policy_;}
  /// Reset a latched contingency (operator command / new flight after landing).
  void clear_latch();

  /// Velocity filter: closest admissible velocity to `desired` that keeps separation.
  Vec3 separation_filter(
    const Vec3 & desired, const SafetyInput & in, bool & modified,
    double & min_sep) const;

private:
  Vec3 goto_velocity(const SafetyInput & in, const Vec3 & target, double speed, bool land) const;
  bool conflict(const Vec3 & v, const SafetyInput & in, double & miss) const;
  void update_discharge(const SafetyInput & in, bool on_ground);
  Vec3 land_velocity(const SafetyInput & in, const Vec3 & horizontal) const;
  bool site_occupied(const Vec3 & site, const SafetyInput & in) const;
  Vec3 clear_safe_site(const SafetyInput & in) const;

  SafetyPolicy policy_;
  Geofence fence_;
  std::string self_;
  Vec3 home_;
  Action latched_{Action::kNominal};
  std::optional<Vec3> latched_target_;
  bool armed_{false};
  double hold_since_{-1.0};
  double touchdown_since_{-1.0};
  double avoid_until_{-1.0};
  double last_reselect_{-1e9};
  bool need_fresh_arm_{false};
  double last_soc_{1.0};
  double last_soc_t_{-1.0};
  double discharge_rate_{0.0};  ///< SOC fraction per second, smoothed
  int discharge_samples_{0};
};

}  // namespace aeropact::safety

#endif  // AEROPACT_SAFETY__SUPERVISOR_HPP_
