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

#ifndef AEROPACT_GEOMETRY__GEOMETRY_HPP_
#define AEROPACT_GEOMETRY__GEOMETRY_HPP_

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace aeropact::geom
{

/// World frame is ENU: x east, y north, z up, metres.
struct Vec3
{
  double x{0.0};
  double y{0.0};
  double z{0.0};

  constexpr Vec3() = default;
  constexpr Vec3(double x_, double y_, double z_ = 0.0)
  : x(x_), y(y_), z(z_) {}

  constexpr Vec3 operator+(const Vec3 & o) const {return {x + o.x, y + o.y, z + o.z};}
  constexpr Vec3 operator-(const Vec3 & o) const {return {x - o.x, y - o.y, z - o.z};}
  constexpr Vec3 operator*(double s) const {return {x * s, y * s, z * s};}
  constexpr Vec3 operator/(double s) const {return {x / s, y / s, z / s};}
  Vec3 & operator+=(const Vec3 & o) {x += o.x; y += o.y; z += o.z; return *this;}
  Vec3 & operator-=(const Vec3 & o) {x -= o.x; y -= o.y; z -= o.z; return *this;}
  constexpr bool operator==(const Vec3 & o) const {return x == o.x && y == o.y && z == o.z;}
};

inline double dot(const Vec3 & a, const Vec3 & b) {return a.x * b.x + a.y * b.y + a.z * b.z;}
inline double norm(const Vec3 & a) {return std::sqrt(dot(a, a));}
inline double norm_xy(const Vec3 & a) {return std::hypot(a.x, a.y);}
inline double dist(const Vec3 & a, const Vec3 & b) {return norm(a - b);}
inline double dist_xy(const Vec3 & a, const Vec3 & b) {return std::hypot(a.x - b.x, a.y - b.y);}

/// Scale `v` down so that its norm is at most `limit`.
inline Vec3 clamp_norm(const Vec3 & v, double limit)
{
  const double n = norm(v);
  return (n > limit && n > 0.0) ? v * (limit / n) : v;
}

/// Scale the horizontal part of `v` down to `limit`, leaving z untouched.
inline Vec3 clamp_xy(const Vec3 & v, double limit)
{
  const double n = norm_xy(v);
  if (n > limit && n > 0.0) {
    const double s = limit / n;
    return {v.x * s, v.y * s, v.z};
  }
  return v;
}

struct Vec2
{
  double x{0.0};
  double y{0.0};
};

using Polygon = std::vector<Vec2>;

/// Even-odd point-in-polygon test (vertices in either winding, implicitly closed).
inline bool contains(const Polygon & poly, double px, double py)
{
  bool inside = false;
  const std::size_t n = poly.size();
  for (std::size_t i = 0, j = n - 1; i < n; j = i++) {
    const Vec2 & a = poly[i];
    const Vec2 & b = poly[j];
    if (((a.y > py) != (b.y > py)) &&
      (px < (b.x - a.x) * (py - a.y) / (b.y - a.y) + a.x))
    {
      inside = !inside;
    }
  }
  return inside;
}

inline double distance_to_segment(double px, double py, const Vec2 & a, const Vec2 & b)
{
  const double dx = b.x - a.x;
  const double dy = b.y - a.y;
  const double len2 = dx * dx + dy * dy;
  double t = 0.0;
  if (len2 > 0.0) {
    t = std::clamp(((px - a.x) * dx + (py - a.y) * dy) / len2, 0.0, 1.0);
  }
  return std::hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/// Distance from a point to the polygon; 0 inside.
inline double distance_to_polygon(const Polygon & poly, double px, double py)
{
  if (poly.size() < 3) {
    return poly.empty() ? INFINITY : std::hypot(px - poly[0].x, py - poly[0].y);
  }
  if (contains(poly, px, py)) {
    return 0.0;
  }
  double best = INFINITY;
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    best = std::min(best, distance_to_segment(px, py, poly[j], poly[i]));
  }
  return best;
}

inline double cross(const Vec2 & o, const Vec2 & a, const Vec2 & b)
{
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

inline bool segments_intersect(const Vec2 & p1, const Vec2 & p2, const Vec2 & q1, const Vec2 & q2)
{
  const double d1 = cross(q1, q2, p1);
  const double d2 = cross(q1, q2, p2);
  const double d3 = cross(p1, p2, q1);
  const double d4 = cross(p1, p2, q2);
  return ((d1 > 0) != (d2 > 0)) && ((d3 > 0) != (d4 > 0));
}

/// True when the segment a-b touches the polygon interior or crosses its boundary.
inline bool segment_intersects_polygon(const Vec2 & a, const Vec2 & b, const Polygon & poly)
{
  if (poly.size() < 3) {
    return false;
  }
  if (contains(poly, a.x, a.y) || contains(poly, b.x, b.y)) {
    return true;
  }
  for (std::size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
    if (segments_intersect(a, b, poly[j], poly[i])) {
      return true;
    }
  }
  return false;
}

/// Regular polygon approximating a circle (used to express circular zones as polygons).
inline Polygon circle_polygon(double cx, double cy, double radius, int sides = 16)
{
  Polygon p;
  p.reserve(static_cast<std::size_t>(sides));
  for (int i = 0; i < sides; ++i) {
    const double a = 2.0 * M_PI * static_cast<double>(i) / static_cast<double>(sides);
    p.push_back({cx + radius * std::cos(a), cy + radius * std::sin(a)});
  }
  return p;
}

struct Bounds
{
  double min_x{0.0};
  double min_y{0.0};
  double max_x{0.0};
  double max_y{0.0};

  bool contains(double x, double y, double margin = 0.0) const
  {
    return x >= min_x + margin && x <= max_x - margin && y >= min_y + margin &&
           y <= max_y - margin;
  }
};

/// Axis-aligned bounds of a polygon.
inline Bounds polygon_bounds(const Polygon & poly)
{
  Bounds b{INFINITY, INFINITY, -INFINITY, -INFINITY};
  for (const auto & v : poly) {
    b.min_x = std::min(b.min_x, v.x);
    b.min_y = std::min(b.min_y, v.y);
    b.max_x = std::max(b.max_x, v.x);
    b.max_y = std::max(b.max_y, v.y);
  }
  return b;
}

/// Wrap an angle to (-pi, pi].
inline double wrap_angle(double a)
{
  while (a > M_PI) {
    a -= 2.0 * M_PI;
  }
  while (a <= -M_PI) {
    a += 2.0 * M_PI;
  }
  return a;
}

}  // namespace aeropact::geom

#endif  // AEROPACT_GEOMETRY__GEOMETRY_HPP_
