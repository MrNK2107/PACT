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

#include "aeropact_px4/offboard_arbiter.hpp"

namespace aeropact::px4
{

const char * to_string(LinkState s)
{
  switch (s) {
    case LinkState::kDisconnected: return "DISCONNECTED";
    case LinkState::kStandby: return "STANDBY";
    case LinkState::kArming: return "ARMING";
    case LinkState::kOffboard: return "OFFBOARD";
    case LinkState::kAutopilotOverride: return "AUTOPILOT_OVERRIDE";
    case LinkState::kDisarming: return "DISARMING";
    case LinkState::kTerminated: return "TERMINATED";
  }
  return "UNKNOWN";
}

const char * to_string(CommandType c)
{
  switch (c) {
    case CommandType::kSetOffboard: return "SET_OFFBOARD";
    case CommandType::kArm: return "ARM";
    case CommandType::kDisarm: return "DISARM";
    case CommandType::kLand: return "LAND";
    case CommandType::kTerminate: return "TERMINATE";
  }
  return "UNKNOWN";
}

void OffboardArbiter::set_enable(bool enable, double now)
{
  if (enable && !enable_) {
    enable_since_ = now;
    override_latched_ = false;  // a fresh request after the supervisor stood down
    armed_this_request_ = false;
    arm_attempts_ = 0;
  }
  if (!enable && enable_) {
    disable_since_ = now;
  }
  enable_ = enable;
}

void OffboardArbiter::request_termination()
{
  terminate_ = true;
}

bool OffboardArbiter::due(double now, double & last) const
{
  if (now - last >= config_.retry_period_s) {
    last = now;
    return true;
  }
  return false;
}

std::vector<CommandType> OffboardArbiter::step(double now, const AutopilotState & s)
{
  std::vector<CommandType> out;
  if (!s.connected) {
    state_ = LinkState::kDisconnected;
    reason_ = "no_autopilot";
    return out;
  }
  if (terminate_ || s.terminated) {
    state_ = LinkState::kTerminated;
    reason_ = s.terminated ? "terminated" : "termination_requested";
    if (!s.terminated && due(now, last_term_cmd_)) {
      out.push_back(CommandType::kTerminate);
    }
    return out;
  }
  if (!s.armed) {
    offboard_seen_ = false;
  }

  if (!enable_) {
    if (s.armed) {
      state_ = LinkState::kDisarming;
      if (s.landed) {
        reason_ = "disarm_requested";
        if (due(now, last_disarm_cmd_)) {
          out.push_back(CommandType::kDisarm);
        }
      } else if (now - disable_since_ < config_.land_detect_grace_s) {
        reason_ = "awaiting_land_detector";
      } else {
        // Never cut motors in the air on a plain disarm request: land instead.
        reason_ = "airborne_disarm_request_landing";
        if (!override_latched_ && due(now, last_disarm_cmd_)) {
          out.push_back(CommandType::kLand);
        }
      }
    } else {
      state_ = LinkState::kStandby;
      reason_ = "standby";
    }
    return out;
  }

  // enable_ is set: the supervisor wants the vehicle flying under fleet control.
  if (s.armed) {
    armed_this_request_ = true;
  } else if (armed_this_request_) {
    // The autopilot disarmed by itself (land detector after touchdown, or its own logic): never
    // undone without a fresh request from the supervisor (D-29).
    state_ = LinkState::kStandby;
    reason_ = "autopilot_disarmed";
    return out;
  }
  if (s.armed && s.offboard && !override_latched_) {
    state_ = LinkState::kOffboard;
    reason_ = "fleet_control";
    offboard_seen_ = true;
    return out;
  }
  if (override_latched_ || (s.armed && !s.offboard && (offboard_seen_ || s.failsafe))) {
    override_latched_ = true;
    state_ = LinkState::kAutopilotOverride;
    reason_ = s.failsafe ? "autopilot_failsafe" : "autopilot_mode_change";
    return out;
  }

  state_ = LinkState::kArming;
  if (now - enable_since_ < config_.stream_before_switch_s) {
    reason_ = "streaming_setpoints";
    return out;
  }
  reason_ = !s.preflight_ok ? "preflight_checks_failing" :
    (arm_attempts_ >= config_.max_arm_attempts ? "arming_rejected" : "arming");
  if (!s.offboard && due(now, last_mode_cmd_)) {
    out.push_back(CommandType::kSetOffboard);
  }
  if (!s.armed && due(now, last_arm_cmd_)) {
    out.push_back(CommandType::kArm);
    ++arm_attempts_;
  }
  return out;
}

}  // namespace aeropact::px4
