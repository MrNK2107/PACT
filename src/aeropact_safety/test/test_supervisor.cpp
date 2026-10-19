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

#include <cmath>

#include "aeropact_safety/supervisor.hpp"

using aeropact::safety::Action;
using aeropact::safety::Contact;
using aeropact::safety::Geofence;
using aeropact::safety::SafetyInput;
using aeropact::safety::SafetyPolicy;
using aeropact::safety::SafetySupervisor;
using aeropact::safety::Vec3;

namespace
{

Geofence fence()
{
  return Geofence::from_yaml_string(
      R"(
world:
  bounds: {min_x: -500, min_y: -500, max_x: 500, max_y: 500}
  depots:
    - id: D1
      position: [0, 0, 0]
      pads:
        - {id: D1-P1, position: [10, 0, 0]}
  public_pads:
    - {id: PUB, position: [300, 300, 0]}
  no_fly:
    - {id: HOSP, polygon: [[100, -50], [150, -50], [150, 50], [100, 50]]}
    - {id: EVENT, dynamic: true, polygon: [[-100, -100], [-50, -100], [-50, -50], [-100, -50]]}
)");
}

SafetySupervisor armed_supervisor()
{
  SafetySupervisor s(SafetyPolicy{}, fence(), "A02", {10, 0, 0});
  SafetyInput in;
  in.arm_request = true;
  in.position = {0, 0, 0};
  s.step(in);
  return s;
}

SafetyInput flying(double t, Vec3 pos, Vec3 cmd)
{
  SafetyInput in;
  in.now = t;
  in.position = pos;
  in.velocity = cmd;
  in.mission_velocity = cmd;
  in.mission_stamp = t;
  in.arm_request = true;
  in.soc = 0.8;
  in.battery_valid = true;
  return in;
}

}  // namespace

TEST(Supervisor, DisarmedUntilArmRequested)
{
  SafetySupervisor s(SafetyPolicy{}, fence(), "A01", {});
  SafetyInput in;
  EXPECT_EQ(s.step(in).action, Action::kDisarmed);
  in.arm_request = true;
  EXPECT_TRUE(s.step(in).armed);
}

TEST(Supervisor, PassesMissionCommandWhenNominal)
{
  auto s = armed_supervisor();
  const auto out = s.step(flying(1.0, {0, -200, 40}, {5, 0, 0}));
  EXPECT_EQ(out.action, Action::kNominal);
  EXPECT_FALSE(out.veto);
  EXPECT_DOUBLE_EQ(out.velocity.x, 5.0);
}

TEST(Supervisor, GeofenceBreachTriggersRtl)
{
  auto s = armed_supervisor();
  // Heading into the hospital zone within the look-ahead.
  const auto out = s.step(flying(1.0, {95, 0, 40}, {8, 0, 0}));
  EXPECT_EQ(out.action, Action::kRtl);
  EXPECT_TRUE(out.veto);
  EXPECT_FALSE(out.geofence_ok);
  EXPECT_EQ(s.latched(), Action::kRtl);
}

TEST(Supervisor, DynamicZonesAreNotPartOfTheStaticFence)
{
  auto s = armed_supervisor();
  const auto out = s.step(flying(1.0, {-75, -75, 40}, {1, 0, 0}));
  EXPECT_TRUE(out.geofence_ok);
}

TEST(Supervisor, BatteryFloorsLatchLandings)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {200, 200, 40}, {5, 0, 0});
  in.soc = 0.08;
  EXPECT_EQ(s.step(in).action, Action::kLandNearest);
  in.soc = 0.03;
  in.now = 2.0;
  const auto out = s.step(in);
  EXPECT_EQ(out.action, Action::kLandNow);
  EXPECT_LT(out.velocity.z, 0.0);
  // Battery recovering in the reading does not cancel a latched landing.
  in.soc = 0.5;
  in.now = 3.0;
  EXPECT_EQ(s.step(in).action, Action::kLandNow);
}

// A battery draining far faster than nominal: the time-based failsafe lands the vehicle while
// the SOC is still well above the fixed floors.
TEST(Supervisor, MeasuredDischargeTriggersLandingBeforeFloors)
{
  auto s = armed_supervisor();
  double soc = 0.40;
  aeropact::safety::Action action = Action::kNominal;
  for (double t = 1.0; t < 60.0 && action == Action::kNominal; t += 0.5) {
    auto in = flying(t, {350, 350, 40}, {5, 0, 0});
    in.soc = soc;
    action = s.step(in).action;
    soc -= 0.01;  // 2 % per second: ~20 s of flight left at 40 %
  }
  EXPECT_TRUE(action == Action::kLandNearest || action == Action::kLandNow);
  EXPECT_GT(soc, 0.10);
}

TEST(Supervisor, WatchdogHoldsThenEscalates)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {0, -200, 40}, {5, 0, 0});
  s.step(in);
  in.now = 3.0;  // command is 2 s old
  auto out = s.step(in);
  EXPECT_EQ(out.action, Action::kHold);
  EXPECT_DOUBLE_EQ(std::hypot(out.velocity.x, out.velocity.y), 0.0);
  in.now = 25.0;
  out = s.step(in);
  EXPECT_EQ(out.action, Action::kRtl);
}

// AT-08 / I4: the separation reflex resolves a head-on conflict with no network at all.
TEST(Supervisor, HeadOnConflictResolvedFromSensingOnly)
{
  auto a = armed_supervisor();
  SafetySupervisor b(SafetyPolicy{}, fence(), "A01", {10, 0, 0});
  SafetyInput arm;
  arm.arm_request = true;
  b.step(arm);
  Vec3 pa{-60, 0, 40};
  Vec3 pb{60, 0, 40};
  Vec3 va{8, 0, 0};
  Vec3 vb{-8, 0, 0};
  double min_dist = 1e9;
  for (double t = 0.0; t < 20.0; t += 0.05) {
    auto ia = flying(t, pa, {8, 0, 0});
    ia.velocity = va;
    ia.contacts = {Contact{"A01", pb - pa, vb - va}};
    auto ib = flying(t, pb, {-8, 0, 0});
    ib.velocity = vb;
    ib.contacts = {Contact{"A02", pa - pb, va - vb}};
    va = a.step(ia).velocity;
    vb = b.step(ib).velocity;
    pa += va * 0.05;
    pb += vb * 0.05;
    const Vec3 d = pa - pb;
    min_dist = std::min(min_dist, std::sqrt(d.x * d.x + d.y * d.y + d.z * d.z));
  }
  EXPECT_GT(min_dist, 6.0);
}

TEST(Supervisor, NoReArmAfterContingencyWithoutFreshRequest)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {10, 0, 0.1}, {0, 0, 0});
  in.velocity = {0, 0, 0};
  in.soc = 0.03;
  s.step(in);
  in.now = 2.5;
  ASSERT_FALSE(s.step(in).armed);
  in.soc = 0.9;  // battery swapped, but the stale request is still asserted
  in.now = 3.0;
  EXPECT_FALSE(s.step(in).armed);
  in.arm_request = false;
  in.now = 3.5;
  s.step(in);
  in.arm_request = true;
  in.now = 4.0;
  EXPECT_TRUE(s.step(in).armed);
}

TEST(Supervisor, SeparationNeverPushesDownNearTheGround)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {0, 0, 3.0}, {0, 0, 0});
  in.velocity = {0, 0, 0};
  // Another aircraft descending onto us from 8 m above.
  in.contacts = {Contact{"A01", {0, 0, 8}, {0, 0, -2}}};
  const auto out = s.step(in);
  EXPECT_TRUE(out.veto);
  EXPECT_GE(out.velocity.z, 0.0);
}

TEST(Supervisor, LandingSideStepsAParkedAircraft)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {200, 200, 8.0}, {0, 0, 0});
  in.velocity = {0, 0, 0};
  in.soc = 0.03;  // land now
  in.contacts = {Contact{"A01", {1.0, 0.0, -8.0}, {0, 0, 0}}};  // parked right below
  auto out = s.step(in);
  EXPECT_EQ(out.action, Action::kLandNow);
  EXPECT_GE(out.velocity.z, 0.0);          // does not descend onto it
  EXPECT_LT(out.velocity.x, -1.0);         // moves away from it
  in.contacts = {Contact{"A01", {12.0, 0.0, -8.0}, {0, 0, 0}}};  // clear
  in.now = 2.0;
  out = s.step(in);
  EXPECT_LT(out.velocity.z, 0.0);
}

TEST(Supervisor, ContingencyLandingDisarmsAfterTouchdown)
{
  auto s = armed_supervisor();
  auto in = flying(1.0, {10, 0, 0.1}, {0, 0, 0});
  in.velocity = {0, 0, 0};
  in.soc = 0.03;
  s.step(in);
  in.now = 2.5;
  const auto out = s.step(in);
  EXPECT_FALSE(out.armed);
  EXPECT_EQ(out.action, Action::kDisarmed);
}
