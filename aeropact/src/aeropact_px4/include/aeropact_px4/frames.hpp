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

#ifndef AEROPACT_PX4__FRAMES_HPP_
#define AEROPACT_PX4__FRAMES_HPP_

#include <array>
#include <cmath>

namespace aeropact::px4
{

/**
 * Frame conventions between the fleet stack and a PX4 autopilot.
 *
 *   fleet "map" frame   ENU (x east, y north, z up), metres, origin at the site's surveyed
 *                       geodetic origin (world.yaml `geodetic_origin`); body frame FLU.
 *   PX4                 NED local frame anchored at the EKF origin, body frame FRD, global
 *                       position in WGS84 latitude / longitude / AMSL altitude.
 *
 * Positions are taken from PX4's *global* estimate and projected onto the site's WGS84 local
 * tangent plane. PX4's own local frame uses a spherical-earth projection whose east scale is off
 * by ~0.3 % at mid latitudes (about 3 m per km), and each vehicle's EKF origin is wherever it
 * initialised, so the local NED position is not a shared fleet frame (D-23).
 */

struct Vec3d
{
  double x{0.0};
  double y{0.0};
  double z{0.0};
};

struct Geodetic
{
  double lat_deg{0.0};
  double lon_deg{0.0};
  double alt_m{0.0};  ///< metres above the ellipsoid / AMSL, used consistently
};

constexpr double kPi = 3.14159265358979323846;
constexpr double kWgs84A = 6378137.0;
constexpr double kWgs84F = 1.0 / 298.257223563;
constexpr double kWgs84E2 = kWgs84F * (2.0 - kWgs84F);

inline double deg2rad(double d) {return d * kPi / 180.0;}
inline double rad2deg(double r) {return r * 180.0 / kPi;}

inline double wrap_pi(double a)
{
  while (a > kPi) {
    a -= 2.0 * kPi;
  }
  while (a < -kPi) {
    a += 2.0 * kPi;
  }
  return a;
}

inline Vec3d geodetic_to_ecef(const Geodetic & g)
{
  const double lat = deg2rad(g.lat_deg);
  const double lon = deg2rad(g.lon_deg);
  const double s = std::sin(lat);
  const double n = kWgs84A / std::sqrt(1.0 - kWgs84E2 * s * s);
  return {(n + g.alt_m) * std::cos(lat) * std::cos(lon),
    (n + g.alt_m) * std::cos(lat) * std::sin(lon),
    (n * (1.0 - kWgs84E2) + g.alt_m) * s};
}

inline Geodetic ecef_to_geodetic(const Vec3d & e)
{
  // Iterative solution; converges to sub-millimetre in a few steps near the surface.
  const double lon = std::atan2(e.y, e.x);
  const double p = std::hypot(e.x, e.y);
  double lat = std::atan2(e.z, p * (1.0 - kWgs84E2));
  double alt = 0.0;
  for (int i = 0; i < 8; ++i) {
    const double s = std::sin(lat);
    const double n = kWgs84A / std::sqrt(1.0 - kWgs84E2 * s * s);
    alt = p / std::cos(lat) - n;
    lat = std::atan2(e.z, p * (1.0 - kWgs84E2 * n / (n + alt)));
  }
  return {rad2deg(lat), rad2deg(lon), alt};
}

/// WGS84 local tangent plane (ENU) at a fixed site origin; the same model Gazebo's spherical
/// coordinates and survey-grade site maps use.
class LocalTangentPlane
{
public:
  LocalTangentPlane() = default;
  explicit LocalTangentPlane(const Geodetic & origin)
  : origin_(origin), origin_ecef_(geodetic_to_ecef(origin))
  {
    const double lat = deg2rad(origin.lat_deg);
    const double lon = deg2rad(origin.lon_deg);
    sl_ = std::sin(lat);
    cl_ = std::cos(lat);
    so_ = std::sin(lon);
    co_ = std::cos(lon);
  }

  const Geodetic & origin() const {return origin_;}

  Vec3d to_enu(const Geodetic & g) const
  {
    const Vec3d e = geodetic_to_ecef(g);
    const double dx = e.x - origin_ecef_.x;
    const double dy = e.y - origin_ecef_.y;
    const double dz = e.z - origin_ecef_.z;
    return {-so_ * dx + co_ * dy,
      -sl_ * co_ * dx - sl_ * so_ * dy + cl_ * dz,
      cl_ * co_ * dx + cl_ * so_ * dy + sl_ * dz};
  }

  Geodetic to_geodetic(const Vec3d & enu) const
  {
    const double dx = -so_ * enu.x - sl_ * co_ * enu.y + cl_ * co_ * enu.z;
    const double dy = co_ * enu.x - sl_ * so_ * enu.y + cl_ * so_ * enu.z;
    const double dz = cl_ * enu.y + sl_ * enu.z;
    return ecef_to_geodetic({origin_ecef_.x + dx, origin_ecef_.y + dy, origin_ecef_.z + dz});
  }

private:
  Geodetic origin_;
  Vec3d origin_ecef_;
  double sl_{0.0};
  double cl_{1.0};
  double so_{0.0};
  double co_{1.0};
};

/// NED <-> ENU for vectors (the transform is its own inverse).
inline Vec3d ned_to_enu(const Vec3d & v) {return {v.y, v.x, -v.z};}
inline Vec3d enu_to_ned(const Vec3d & v) {return {v.y, v.x, -v.z};}

/// Heading conventions: NED yaw is clockwise from north, ENU yaw counter-clockwise from east.
inline double yaw_ned_to_enu(double yaw_ned) {return wrap_pi(kPi / 2.0 - yaw_ned);}
inline double yaw_enu_to_ned(double yaw_enu) {return wrap_pi(kPi / 2.0 - yaw_enu);}

/// Quaternion (w, x, y, z).
using Quat = std::array<double, 4>;

inline void quat_to_rpy(const Quat & q, double & roll, double & pitch, double & yaw)
{
  const double w = q[0];
  const double x = q[1];
  const double y = q[2];
  const double z = q[3];
  roll = std::atan2(2.0 * (w * x + y * z), 1.0 - 2.0 * (x * x + y * y));
  const double sp = 2.0 * (w * y - z * x);
  pitch = std::abs(sp) >= 1.0 ? std::copysign(kPi / 2.0, sp) : std::asin(sp);
  yaw = std::atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z));
}

inline Quat rpy_to_quat(double roll, double pitch, double yaw)
{
  const double cr = std::cos(roll / 2.0);
  const double sr = std::sin(roll / 2.0);
  const double cp = std::cos(pitch / 2.0);
  const double sp = std::sin(pitch / 2.0);
  const double cy = std::cos(yaw / 2.0);
  const double sy = std::sin(yaw / 2.0);
  return {cr * cp * cy + sr * sp * sy, sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy};
}

/// PX4 attitude (FRD body -> NED) to ROS attitude (FLU body -> ENU).
inline Quat attitude_ned_frd_to_enu_flu(const Quat & q_ned)
{
  double roll = 0.0;
  double pitch = 0.0;
  double yaw = 0.0;
  quat_to_rpy(q_ned, roll, pitch, yaw);
  return rpy_to_quat(roll, -pitch, yaw_ned_to_enu(yaw));
}

/// Rotates a world-frame vector into the yaw-only body frame (heading frame) and back.
inline Vec3d world_to_heading(const Vec3d & v, double yaw)
{
  const double c = std::cos(yaw);
  const double s = std::sin(yaw);
  return {c * v.x + s * v.y, -s * v.x + c * v.y, v.z};
}

inline Vec3d heading_to_world(const Vec3d & v, double yaw)
{
  const double c = std::cos(yaw);
  const double s = std::sin(yaw);
  return {c * v.x - s * v.y, s * v.x + c * v.y, v.z};
}

}  // namespace aeropact::px4

#endif  // AEROPACT_PX4__FRAMES_HPP_
