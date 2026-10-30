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
#include <cmath>
#include <optional>
#include <string>

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

TEST(Supervisor, AutopilotTakeoverLatchesAboveEverythingAndDisarmsOnlyAfterLanding)
{
  auto s = armed_supervisor();
  SafetyInput in = flying(1.0, {0, 0, 40}, {5, 0, 0});
  in.autopilot_present = true;
  EXPECT_EQ(s.step(in).action, Action::kNominal);
  // The flight controller's failsafe (or a remote pilot) takes over in flight.
  in = flying(2.0, {5, 0, 40}, {5, 0, 0});
  in.autopilot_present = true;
  in.autopilot_override = true;
  in.soc = 0.02;  // even a critical battery does not make the supervisor contest it
  auto out = s.step(in);
  EXPECT_EQ(out.action, Action::kAutopilot);
  EXPECT_TRUE(out.veto);
  EXPECT_TRUE(out.armed);
  EXPECT_DOUBLE_EQ(out.velocity.x, 0.0);
  // The autopilot lands the vehicle; its land detector ends the latch, a few decimetres of
  // height estimate error notwithstanding.
  for (double t = 3.0; t < 5.0; t += 0.1) {
    in = flying(t, {5, 0, 0.6}, {0, 0, 0});
    in.velocity = {0, 0, 0};
    in.autopilot_present = true;
    in.autopilot_override = true;
    in.autopilot_landed = true;
    out = s.step(in);
  }
  EXPECT_FALSE(out.armed);
  EXPECT_EQ(out.action, Action::kDisarmed);
  // A stale arm request does not relaunch it; a fresh one does.
  in.autopilot_override = false;
  EXPECT_FALSE(s.step(in).armed);
  in.arm_request = false;
  s.step(in);
  in.arm_request = true;
  EXPECT_TRUE(s.step(in).armed);
}

TEST(Supervisor, NeverDescendsOntoAParkedAircraftInAMissionLanding)
{
  // A mission landing (nominal mode) straight down onto a pad that another vehicle occupies.
  auto s = armed_supervisor();
  SafetyInput in = flying(1.0, {412, 330, 6.0}, {0, 0, -1.5});
  in.contacts.push_back({"A03", {0.1, 0.0, -6.0}, {0.0, 0.0, 1.5}});  // parked: world vel 0
  auto out = s.step(in);
  EXPECT_DOUBLE_EQ(out.velocity.z, 0.0);
  EXPECT_TRUE(out.veto);
  EXPECT_EQ(out.action, Action::kAvoid);
  EXPECT_EQ(out.reason, "occupied_landing_spot");
  // The neighbouring pad 12 m away does not block the descent.
  SafetySupervisor s2 = armed_supervisor();
  in.contacts = {{"A03", {12.0, 0.0, -6.0}, {0.0, 0.0, 1.5}}};
  EXPECT_LT(s2.step(in).velocity.z, 0.0);
  // Once the pad is clear the descent proceeds.
  SafetySupervisor s3 = armed_supervisor();
  in.contacts.clear();
  EXPECT_LT(s3.step(in).velocity.z, 0.0);
}

namespace
{

// Closed loop: two point-mass vehicles, each with its own supervisor, sensing each other.
struct SimVehicle
{
  std::string id;
  Vec3 pos;
  Vec3 vel;
  double soc{0.8};
  std::optional<Vec3> mission_target;  // mission landing target (nominal mode)
};

SafetyInput sense(const SimVehicle & self, const SimVehicle & other, double t)
{
  SafetyInput in;
  in.now = t;
  in.position = self.pos;
  in.velocity = self.vel;
  in.soc = self.soc;
  in.battery_valid = true;
  in.arm_request = true;
  in.contacts.push_back({other.id, other.pos - self.pos, other.vel - self.vel});
  if (self.mission_target) {
    Vec3 v = (*self.mission_target - self.pos) * 0.5;
    v = aeropact::geom::clamp_xy(v, 3.0);
    v.z = aeropact::geom::dist_xy(self.pos, *self.mission_target) < 1.5 ? -1.0 : 0.0;
    in.mission_velocity = v;
    in.mission_stamp = t;
  }
  return in;
}

void integrate(SimVehicle & v, const Vec3 & cmd, double dt)
{
  v.vel = cmd;
  v.pos = v.pos + cmd * dt;
  if (v.pos.z < 0.0) {
    v.pos.z = 0.0;
    v.vel.z = 0.0;
  }
}

Geofence two_pad_fence()
{
  return Geofence::from_yaml_string(
      R"(
world:
  bounds: {min_x: -500, min_y: -500, max_x: 500, max_y: 500}
  depots:
    - id: D1
      position: [0, -30, 0]
      pads:
        - {id: D1-P1, position: [0, 0, 0]}
        - {id: D1-P2, position: [12, 0, 0]}
  safe_sites:
    - {id: S1, position: [60, 0, 0]}
)");
}

}  // namespace

// D-28 regression: an emergency landing above a pad another vehicle is landing on picks a clear
// site instead of queueing above it, never climbs away in lockstep, and both vehicles land with
// separation kept throughout.
TEST(Supervisor, EmergencyLandingAvoidsAPadAnotherVehicleIsLandingOn)
{
  SafetySupervisor sa(SafetyPolicy{}, two_pad_fence(), "A06", {0, 0, 0});
  SafetySupervisor sb(SafetyPolicy{}, two_pad_fence(), "A03", {0, 0, 0});
  SimVehicle a{"A06", {2, 1, 10}, {0, 0, 0}, 0.08, std::nullopt};      // below the SOC floor
  SimVehicle b{"A03", {0, 0, 6}, {0, 0, 0}, 0.8, Vec3{0, 0, 0}};       // landing on D1-P1
  double min_sep = 1e9;
  double max_alt_a = 0.0;
  const double dt = 0.05;
  for (double t = 0.0; t < 150.0; t += dt) {
    a.soc = t < 0.1 ? 0.5 : 0.08;  // armed in flight, then below the SOC floor
    const auto oa = sa.step(sense(a, b, t));
    const auto ob = sb.step(sense(b, a, t));
    integrate(a, oa.armed ? oa.velocity : Vec3{0, 0, 0}, dt);
    integrate(b, ob.armed ? ob.velocity : Vec3{0, 0, 0}, dt);
    min_sep = std::min(min_sep, aeropact::geom::dist(a.pos, b.pos));
    max_alt_a = std::max(max_alt_a, a.pos.z);
  }
  EXPECT_LT(a.pos.z, 0.1) << "the low-battery vehicle must be on the ground";
  EXPECT_LT(b.pos.z, 0.1);
  EXPECT_GT(min_sep, 2.0);
  EXPECT_LT(max_alt_a, 25.0) << "no climb-away on the final approach";
  EXPECT_GT(aeropact::geom::dist_xy(a.pos, b.pos), 3.0) << "landed beside, not on top";
}

// A pad already occupied by a parked aircraft is not chosen while a clear site exists.
TEST(Supervisor, EmergencyLandingSkipsAnOccupiedPad)
{
  SafetySupervisor sa(SafetyPolicy{}, two_pad_fence(), "A06", {0, 0, 0});
  SafetySupervisor sb(SafetyPolicy{}, two_pad_fence(), "A01", {0, 0, 0});
  SimVehicle a{"A06", {1, 0, 12}, {0, 0, 0}, 0.08, std::nullopt};
  SimVehicle b{"A01", {0, 0, 0}, {0, 0, 0}, 0.8, std::nullopt};  // parked on D1-P1
  const double dt = 0.05;
  double min_sep = 1e9;
  for (double t = 0.0; t < 120.0; t += dt) {
    a.soc = t < 0.1 ? 0.5 : 0.08;
    const auto oa = sa.step(sense(a, b, t));
    SafetyInput ib = sense(b, a, t);
    ib.arm_request = false;  // parked and disarmed
    sb.step(ib);
    integrate(a, oa.armed ? oa.velocity : Vec3{0, 0, 0}, dt);
    min_sep = std::min(min_sep, aeropact::geom::dist(a.pos, b.pos));
  }
  EXPECT_LT(a.pos.z, 0.1);
  EXPECT_NEAR(a.pos.x, 12.0, 1.5) << "landed on the clear neighbouring pad";
  EXPECT_GT(min_sep, 3.0);
}
