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

#ifndef AEROPACT_PX4__OFFBOARD_ARBITER_HPP_
#define AEROPACT_PX4__OFFBOARD_ARBITER_HPP_

#include <cstdint>
#include <string>
#include <vector>

namespace aeropact::px4
{

/// What the companion computer knows about the autopilot (from VehicleStatus and friends).
struct AutopilotState
{
  bool connected{false};      ///< status heard within the link timeout
  bool armed{false};
  bool offboard{false};       ///< navigation state is OFFBOARD
  bool landed{true};
  bool failsafe{false};       ///< the autopilot's own failsafe is active
  bool preflight_ok{false};
  bool terminated{false};     ///< flight termination (motors cut)
};

/// The interface's view of who flies the vehicle.
enum class LinkState : std::uint8_t
{
  kDisconnected = 0,      ///< no autopilot status: nothing is commanded
  kStandby = 1,           ///< disarmed, not asked to fly
  kArming = 2,            ///< streaming setpoints, switching to offboard and arming
  kOffboard = 3,          ///< the fleet stack flies the vehicle
  kAutopilotOverride = 4,  ///< the autopilot (failsafe, pilot, RTL) took over; never fought
  kDisarming = 5,         ///< landing or disarming on request
  kTerminated = 6,        ///< flight termination commanded or reported
};
const char * to_string(LinkState s);

enum class CommandType : std::uint8_t
{
  kSetOffboard = 0,
  kArm = 1,
  kDisarm = 2,
  kLand = 3,
  kTerminate = 4,
};
const char * to_string(CommandType c);

struct ArbiterConfig
{
  double stream_before_switch_s{1.0};  ///< PX4 needs a live setpoint stream before OFFBOARD
  double retry_period_s{1.0};          ///< command retry period
  int max_arm_attempts{15};            ///< after this many, report the arming as rejected
  /// A disarm request just after touchdown precedes the land detector by a second or two; only
  /// a vehicle still airborne after this grace is told to LAND.
  double land_detect_grace_s{3.0};
};

/**
 * Offboard arbitration between the fleet stack's safety supervisor and a PX4 autopilot.
 *
 * Rules (D-23):
 *   - The supervisor's `enable` is a request, not a command: the vehicle is armed and switched to
 *     OFFBOARD only after the setpoint stream has been live for `stream_before_switch_s`.
 *   - Once OFFBOARD was reached, any mode change made by the autopilot (its failsafes, a remote
 *     pilot, a ground station RTL) latches AUTOPILOT_OVERRIDE. The interface never switches back
 *     on its own; only a fresh enable (false -> true) after the supervisor stood down clears it.
 *   - A disarm request while airborne becomes a LAND command; motors are never cut in the air
 *     except by an explicit termination request.
 *   - A disarm made by the autopilot itself (its land detector after touchdown) is never undone:
 *     the vehicle is armed again only on a fresh enable (false -> true), D-29.
 *   - Velocity setpoints are forwarded only in OFFBOARD; otherwise the stream carries zeros.
 */
class OffboardArbiter
{
public:
  explicit OffboardArbiter(ArbiterConfig config = {})
  : config_(config) {}

  void set_enable(bool enable, double now);
  void request_termination();

  /// Advances the state machine; returns the commands to send now.
  std::vector<CommandType> step(double now, const AutopilotState & s);

  LinkState state() const {return state_;}
  const std::string & reason() const {return reason_;}
  bool forward_velocity() const {return state_ == LinkState::kOffboard;}
  int arm_attempts() const {return arm_attempts_;}

private:
  bool due(double now, double & last) const;

  ArbiterConfig config_;
  LinkState state_{LinkState::kDisconnected};
  std::string reason_{"no_autopilot"};
  bool enable_{false};
  double enable_since_{-1.0};
  double disable_since_{-1e9};
  bool override_latched_{false};
  bool offboard_seen_{false};
  bool armed_this_request_{false};  ///< armed since the last enable rising edge
  bool terminate_{false};
  double last_mode_cmd_{-1e9};
  double last_arm_cmd_{-1e9};
  double last_disarm_cmd_{-1e9};
  double last_term_cmd_{-1e9};
  int arm_attempts_{0};
};

}  // namespace aeropact::px4

#endif  // AEROPACT_PX4__OFFBOARD_ARBITER_HPP_
