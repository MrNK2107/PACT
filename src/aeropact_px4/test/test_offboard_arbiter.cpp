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

#include <gtest/gtest.h>

#include <algorithm>
#include <random>
#include <vector>

#include "aeropact_px4/offboard_arbiter.hpp"

using aeropact::px4::AutopilotState;
using aeropact::px4::CommandType;
using aeropact::px4::LinkState;
using aeropact::px4::OffboardArbiter;

namespace
{

bool has(const std::vector<CommandType> & v, CommandType c)
{
  return std::find(v.begin(), v.end(), c) != v.end();
}

AutopilotState on_ground()
{
  AutopilotState s;
  s.connected = true;
  s.preflight_ok = true;
  s.landed = true;
  return s;
}

}  // namespace

TEST(OffboardArbiter, NothingIsCommandedWithoutAnAutopilot)
{
  OffboardArbiter a;
  a.set_enable(true, 0.0);
  AutopilotState s;  // not connected
  EXPECT_TRUE(a.step(5.0, s).empty());
  EXPECT_EQ(a.state(), LinkState::kDisconnected);
  EXPECT_FALSE(a.forward_velocity());
}

TEST(OffboardArbiter, StreamsBeforeSwitchingThenArmsIntoOffboard)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  EXPECT_TRUE(a.step(0.0, s).empty());
  EXPECT_EQ(a.state(), LinkState::kStandby);
  a.set_enable(true, 1.0);
  EXPECT_TRUE(a.step(1.5, s).empty());  // setpoint stream not yet live long enough
  EXPECT_EQ(a.reason(), "streaming_setpoints");
  auto c = a.step(2.1, s);
  EXPECT_TRUE(has(c, CommandType::kSetOffboard));
  EXPECT_TRUE(has(c, CommandType::kArm));
  EXPECT_FALSE(a.forward_velocity());
  // Not repeated faster than the retry period.
  EXPECT_TRUE(a.step(2.5, s).empty());
  s.armed = true;
  s.offboard = true;
  EXPECT_TRUE(a.step(2.6, s).empty());
  EXPECT_EQ(a.state(), LinkState::kOffboard);
  EXPECT_TRUE(a.forward_velocity());
}

TEST(OffboardArbiter, ArmedButNotYetOffboardKeepsAskingForTheMode)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  a.set_enable(true, 0.0);
  s.armed = true;  // armed by the first command; the mode switch is still pending
  auto c = a.step(1.5, s);
  EXPECT_TRUE(has(c, CommandType::kSetOffboard));
  EXPECT_FALSE(has(c, CommandType::kArm));
  EXPECT_EQ(a.state(), LinkState::kArming);
}

TEST(OffboardArbiter, AutopilotModeChangeLatchesOverrideAndIsNeverFought)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  a.set_enable(true, 0.0);
  s.armed = true;
  s.offboard = true;
  s.landed = false;
  a.step(2.0, s);
  ASSERT_EQ(a.state(), LinkState::kOffboard);
  // The autopilot's failsafe switches to RTL.
  s.offboard = false;
  for (double t = 2.1; t < 30.0; t += 0.1) {
    const auto c = a.step(t, s);
    EXPECT_TRUE(c.empty()) << "commanded at t=" << t;
    EXPECT_EQ(a.state(), LinkState::kAutopilotOverride);
    EXPECT_FALSE(a.forward_velocity());
  }
  // Even if the autopilot later returns to OFFBOARD by itself, the latch holds...
  s.offboard = true;
  a.step(31.0, s);
  EXPECT_EQ(a.state(), LinkState::kAutopilotOverride);
  // ...until the supervisor stands down and asks again.
  a.set_enable(false, 40.0);
  s.offboard = false;
  s.armed = false;
  s.landed = true;
  a.step(41.0, s);
  EXPECT_EQ(a.state(), LinkState::kStandby);
  a.set_enable(true, 42.0);
  const auto c = a.step(43.5, s);
  EXPECT_TRUE(has(c, CommandType::kArm));
}

TEST(OffboardArbiter, AutopilotDisarmIsNeverUndoneWithoutAFreshRequest)
{
  // Touchdown: PX4's land detector auto-disarms (COM_DISARM_LAND) a moment before the
  // supervisor withdraws `enable`. Re-arming a parked vehicle would fight the autopilot.
  OffboardArbiter a;
  AutopilotState s = on_ground();
  a.set_enable(true, 0.0);
  s.armed = true;
  s.offboard = true;
  a.step(2.0, s);
  ASSERT_EQ(a.state(), LinkState::kOffboard);
  s.armed = false;  // the autopilot disarmed on its own
  for (double t = 2.1; t < 20.0; t += 0.1) {
    const auto c = a.step(t, s);
    EXPECT_FALSE(has(c, CommandType::kArm)) << "re-armed at t=" << t;
    EXPECT_FALSE(has(c, CommandType::kSetOffboard)) << "t=" << t;
    EXPECT_EQ(a.state(), LinkState::kStandby);
  }
  EXPECT_EQ(a.reason(), "autopilot_disarmed");
  // The next mission (enable false -> true) arms again.
  a.set_enable(false, 20.0);
  a.step(20.5, s);
  a.set_enable(true, 21.0);
  EXPECT_TRUE(has(a.step(22.5, s), CommandType::kArm));
}

TEST(OffboardArbiter, FailsafeBeforeOffboardIsAnOverrideToo)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  a.set_enable(true, 0.0);
  s.armed = true;
  s.failsafe = true;
  EXPECT_TRUE(a.step(2.0, s).empty());
  EXPECT_EQ(a.state(), LinkState::kAutopilotOverride);
  EXPECT_EQ(a.reason(), "autopilot_failsafe");
}

TEST(OffboardArbiter, DisarmOnTheGroundButLandWhenAirborne)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  s.armed = true;
  s.offboard = true;
  s.landed = false;
  a.set_enable(true, 0.0);
  a.step(1.5, s);
  a.set_enable(false, 2.0);
  // Just after the request the land detector gets its grace period: nothing is commanded.
  auto c = a.step(3.0, s);
  EXPECT_TRUE(c.empty());
  EXPECT_EQ(a.reason(), "awaiting_land_detector");
  // Still airborne afterwards: LAND, never disarm or terminate.
  c = a.step(5.5, s);
  EXPECT_TRUE(has(c, CommandType::kLand));
  EXPECT_FALSE(has(c, CommandType::kDisarm));
  EXPECT_FALSE(has(c, CommandType::kTerminate));
  s.landed = true;
  c = a.step(7.0, s);
  EXPECT_TRUE(has(c, CommandType::kDisarm));
  s.armed = false;
  a.step(7.5, s);
  EXPECT_EQ(a.state(), LinkState::kStandby);
}

TEST(OffboardArbiter, TerminationOnlyOnExplicitRequestAndItWins)
{
  OffboardArbiter a;
  AutopilotState s = on_ground();
  s.armed = true;
  s.offboard = true;
  s.landed = false;
  a.set_enable(true, 0.0);
  a.step(2.0, s);
  a.request_termination();
  auto c = a.step(2.1, s);
  EXPECT_EQ(c, std::vector<CommandType>{CommandType::kTerminate});
  EXPECT_EQ(a.state(), LinkState::kTerminated);
  s.terminated = true;
  EXPECT_TRUE(a.step(5.0, s).empty());
  EXPECT_EQ(a.state(), LinkState::kTerminated);
}

TEST(OffboardArbiter, ReportsRejectedArmingAfterTheAttemptBudget)
{
  aeropact::px4::ArbiterConfig cfg;
  cfg.max_arm_attempts = 3;
  OffboardArbiter a(cfg);
  AutopilotState s = on_ground();
  s.preflight_ok = true;
  a.set_enable(true, 0.0);
  for (double t = 1.0; t < 10.0; t += 0.5) {
    a.step(t, s);
  }
  EXPECT_EQ(a.reason(), "arming_rejected");
  EXPECT_GE(a.arm_attempts(), 3);
  s.preflight_ok = false;
  a.step(11.0, s);
  EXPECT_EQ(a.reason(), "preflight_checks_failing");
}

// Property: over random autopilot behaviour, the arbiter never terminates without a request,
// never disarms while airborne, never forwards velocity outside OFFBOARD, and never issues a
// command while disconnected.
TEST(OffboardArbiter, RandomisedSafetyProperties)
{
  std::mt19937 rng(7);
  std::bernoulli_distribution flip(0.08);
  for (int trial = 0; trial < 200; ++trial) {
    OffboardArbiter a;
    AutopilotState s = on_ground();
    bool enable = false;
    for (double t = 0.0; t < 120.0; t += 0.05) {
      if (flip(rng)) {enable = !enable; a.set_enable(enable, t);}
      if (flip(rng)) {s.connected = !s.connected;}
      if (flip(rng)) {s.armed = !s.armed;}
      if (flip(rng)) {s.offboard = !s.offboard;}
      if (flip(rng)) {s.landed = !s.landed;}
      if (flip(rng)) {s.failsafe = !s.failsafe;}
      const auto c = a.step(t, s);
      ASSERT_FALSE(has(c, CommandType::kTerminate)) << "trial " << trial << " t=" << t;
      if (!s.landed) {
        ASSERT_FALSE(has(c, CommandType::kDisarm)) << "trial " << trial << " t=" << t;
      }
      if (!s.connected) {
        ASSERT_TRUE(c.empty());
      }
      if (a.forward_velocity()) {
        ASSERT_TRUE(s.armed && s.offboard && enable);
      }
    }
  }
}
