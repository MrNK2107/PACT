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
#include <random>

#include "aeropact_px4/frames.hpp"

using aeropact::px4::Geodetic;
using aeropact::px4::LocalTangentPlane;
using aeropact::px4::Quat;
using aeropact::px4::Vec3d;
namespace px4 = aeropact::px4;

TEST(Frames, OriginMapsToZero)
{
  const Geodetic o{47.397742, 8.545594, 488.0};
  const LocalTangentPlane ltp(o);
  const Vec3d e = ltp.to_enu(o);
  EXPECT_NEAR(e.x, 0.0, 1e-6);
  EXPECT_NEAR(e.y, 0.0, 1e-6);
  EXPECT_NEAR(e.z, 0.0, 1e-6);
}

TEST(Frames, KnownOffsetsMatchEllipsoidRadii)
{
  // One arc-second of latitude / longitude at 47.4 N on WGS84: meridional radius M and prime
  // vertical radius N give 30.88 m north and 20.97 m east.
  const Geodetic o{47.4, 8.5, 400.0};
  const LocalTangentPlane ltp(o);
  const Vec3d n = ltp.to_enu({47.4 + 1.0 / 3600.0, 8.5, 400.0});
  const Vec3d e = ltp.to_enu({47.4, 8.5 + 1.0 / 3600.0, 400.0});
  EXPECT_NEAR(n.y, 30.88, 0.01);
  EXPECT_NEAR(n.x, 0.0, 1e-3);
  EXPECT_NEAR(e.x, 20.97, 0.01);
  EXPECT_NEAR(e.y, 0.0, 1e-3);
  // Altitude maps to up (curvature drop over 30 m is sub-millimetre).
  const Vec3d u = ltp.to_enu({47.4, 8.5, 450.0});
  EXPECT_NEAR(u.z, 50.0, 1e-6);
}

TEST(Frames, RoundTripOverASiteIsSubMillimetre)
{
  const LocalTangentPlane ltp({-33.8688, 151.2093, 20.0});
  std::mt19937 rng(3);
  std::uniform_real_distribution<double> xy(-6000.0, 6000.0);
  std::uniform_real_distribution<double> z(-50.0, 400.0);
  for (int i = 0; i < 500; ++i) {
    const Vec3d p{xy(rng), xy(rng), z(rng)};
    const Vec3d q = ltp.to_enu(ltp.to_geodetic(p));
    ASSERT_NEAR(q.x, p.x, 1e-3);
    ASSERT_NEAR(q.y, p.y, 1e-3);
    ASSERT_NEAR(q.z, p.z, 1e-3);
  }
}

TEST(Frames, NedEnuSwapIsAnInvolution)
{
  const Vec3d v{1.0, 2.0, 3.0};
  const Vec3d e = px4::ned_to_enu(v);
  EXPECT_DOUBLE_EQ(e.x, 2.0);
  EXPECT_DOUBLE_EQ(e.y, 1.0);
  EXPECT_DOUBLE_EQ(e.z, -3.0);
  const Vec3d b = px4::enu_to_ned(e);
  EXPECT_DOUBLE_EQ(b.x, v.x);
  EXPECT_DOUBLE_EQ(b.y, v.y);
  EXPECT_DOUBLE_EQ(b.z, v.z);
}

TEST(Frames, HeadingConventions)
{
  // North in NED (0) is +90 deg in ENU; east in NED (+90) is 0 in ENU.
  EXPECT_NEAR(px4::yaw_ned_to_enu(0.0), px4::kPi / 2.0, 1e-12);
  EXPECT_NEAR(px4::yaw_ned_to_enu(px4::kPi / 2.0), 0.0, 1e-12);
  for (double y = -3.0; y < 3.0; y += 0.37) {
    EXPECT_NEAR(px4::wrap_pi(px4::yaw_enu_to_ned(px4::yaw_ned_to_enu(y)) - y), 0.0, 1e-12);
  }
}

TEST(Frames, AttitudeConversionPreservesTiltAndMapsHeading)
{
  // Vehicle facing east, pitched nose-down 10 deg (NED/FRD: pitch -10 deg, yaw +90 deg).
  const Quat q_ned = px4::rpy_to_quat(0.0, px4::deg2rad(-10.0), px4::deg2rad(90.0));
  const Quat q_enu = px4::attitude_ned_frd_to_enu_flu(q_ned);
  double r = 0.0;
  double p = 0.0;
  double y = 0.0;
  px4::quat_to_rpy(q_enu, r, p, y);
  EXPECT_NEAR(y, 0.0, 1e-9);                      // east in ENU
  EXPECT_NEAR(p, px4::deg2rad(10.0), 1e-9);       // FLU pitch is the negative of FRD pitch
  EXPECT_NEAR(r, 0.0, 1e-9);
  const double norm = std::sqrt(q_enu[0] * q_enu[0] + q_enu[1] * q_enu[1] +
      q_enu[2] * q_enu[2] + q_enu[3] * q_enu[3]);
  EXPECT_NEAR(norm, 1.0, 1e-12);
}

TEST(Frames, HeadingFrameRoundTrip)
{
  const Vec3d v{3.0, -4.0, 1.5};
  for (double yaw = -3.1; yaw < 3.1; yaw += 0.5) {
    const Vec3d w = px4::heading_to_world(px4::world_to_heading(v, yaw), yaw);
    EXPECT_NEAR(w.x, v.x, 1e-12);
    EXPECT_NEAR(w.y, v.y, 1e-12);
    EXPECT_NEAR(w.z, v.z, 1e-12);
  }
}
