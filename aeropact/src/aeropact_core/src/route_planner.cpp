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

#include "aeropact_core/route_planner.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <queue>
#include <utility>

namespace aeropact::core
{

RoutePlanner::RoutePlanner(const WorldModel & world, PlannerConfig config)
: world_(world), config_(config) {}

void RoutePlanner::to_cell(double x, double y, int & ix, int & iy) const
{
  ix = static_cast<int>(std::floor((x - world_.bounds.min_x) / config_.cell_m));
  iy = static_cast<int>(std::floor((y - world_.bounds.min_y) / config_.cell_m));
}

void RoutePlanner::cell_centre(int ix, int iy, double & x, double & y) const
{
  x = world_.bounds.min_x + (ix + 0.5) * config_.cell_m;
  y = world_.bounds.min_y + (iy + 0.5) * config_.cell_m;
}

const RoutePlanner::Raster & RoutePlanner::raster(double alt)
{
  for (const auto & r : cache_) {
    if (std::abs(r.alt - alt) < 0.5 && r.airspace_version == world_.airspace_version()) {
      return r;
    }
  }
  Raster r;
  r.alt = alt;
  r.airspace_version = world_.airspace_version();
  r.nx = static_cast<int>(std::ceil((world_.bounds.max_x - world_.bounds.min_x) / config_.cell_m));
  r.ny = static_cast<int>(std::ceil((world_.bounds.max_y - world_.bounds.min_y) / config_.cell_m));
  r.blocked.assign(static_cast<std::size_t>(r.nx * r.ny), 0);

  auto stamp = [&](const geom::Polygon & poly) {
      const geom::Bounds b = geom::polygon_bounds(poly);
      int x0 = 0;
      int y0 = 0;
      int x1 = 0;
      int y1 = 0;
      to_cell(b.min_x - config_.inflate_m, b.min_y - config_.inflate_m, x0, y0);
      to_cell(b.max_x + config_.inflate_m, b.max_y + config_.inflate_m, x1, y1);
      x0 = std::max(0, x0);
      y0 = std::max(0, y0);
      x1 = std::min(r.nx - 1, x1);
      y1 = std::min(r.ny - 1, y1);
      for (int iy = y0; iy <= y1; ++iy) {
        for (int ix = x0; ix <= x1; ++ix) {
          double cx = 0.0;
          double cy = 0.0;
          cell_centre(ix, iy, cx, cy);
          // Half a cell diagonal of extra margin keeps the raster conservative. Cells that touch
          // the obstacle itself are hard (2); the inflation margin around it is soft (1).
          const double d = geom::distance_to_polygon(poly, cx, cy);
          const std::uint8_t level = d <= 0.71 * config_.cell_m ? 2 :
            (d <= config_.inflate_m + 0.71 * config_.cell_m ? 1 : 0);
          auto & cell = r.blocked[static_cast<std::size_t>(iy * r.nx + ix)];
          cell = std::max(cell, level);
        }
      }
    };
  for (const auto & z : world_.no_fly) {
    if (z.active && alt >= z.floor_m && alt <= z.ceiling_m) {
      stamp(z.polygon);
    }
  }
  for (const auto & bld : world_.buildings) {
    if (bld.height_m + config_.building_clearance_m >= alt) {
      stamp(bld.footprint);
    }
  }
  // Keep a margin inside the operating area.
  const int m = static_cast<int>(std::ceil(config_.boundary_margin_m / config_.cell_m));
  for (int iy = 0; iy < r.ny; ++iy) {
    for (int ix = 0; ix < r.nx; ++ix) {
      if (ix < m || iy < m || ix >= r.nx - m || iy >= r.ny - m) {
        r.blocked[static_cast<std::size_t>(iy * r.nx + ix)] = 2;
      }
    }
  }
  if (cache_.size() >= 6) {
    cache_.erase(cache_.begin());
  }
  cache_.push_back(std::move(r));
  return cache_.back();
}

bool RoutePlanner::cell_blocked(const Raster & r, int ix, int iy) const
{
  return cell_level(r, ix, iy) != 0;
}

std::uint8_t RoutePlanner::cell_level(const Raster & r, int ix, int iy) const
{
  if (ix < 0 || iy < 0 || ix >= r.nx || iy >= r.ny) {
    return 2;
  }
  return r.blocked[static_cast<std::size_t>(iy * r.nx + ix)];
}

bool RoutePlanner::line_clear(const Raster & r, double ax, double ay, double bx, double by) const
{
  const double d = std::hypot(bx - ax, by - ay);
  const int steps = std::max(1, static_cast<int>(std::ceil(d / (0.4 * config_.cell_m))));
  for (int i = 0; i <= steps; ++i) {
    const double t = static_cast<double>(i) / steps;
    int ix = 0;
    int iy = 0;
    to_cell(ax + t * (bx - ax), ay + t * (by - ay), ix, iy);
    if (cell_blocked(r, ix, iy)) {
      return false;
    }
  }
  return true;
}

bool RoutePlanner::segment_clear(const Vec3 & a, const Vec3 & b, double alt)
{
  return line_clear(raster(alt), a.x, a.y, b.x, b.y);
}

double RoutePlanner::length(const std::vector<Vec3> & path)
{
  double l = 0.0;
  for (std::size_t i = 1; i < path.size(); ++i) {
    l += geom::dist(path[i - 1], path[i]);
  }
  return l;
}

std::optional<std::vector<Vec3>> RoutePlanner::plan(
  const Vec3 & from, const Vec3 & to, double cruise_alt)
{
  const Raster & r = raster(cruise_alt);
  const Vec3 a{from.x, from.y, cruise_alt};
  const Vec3 b{to.x, to.y, cruise_alt};
  if (line_clear(r, a.x, a.y, b.x, b.y)) {
    return std::vector<Vec3>{a, b};
  }
  int sx = 0;
  int sy = 0;
  int gx = 0;
  int gy = 0;
  to_cell(a.x, a.y, sx, sy);
  to_cell(b.x, b.y, gx, gy);
  const int nx = r.nx;
  const int ny = r.ny;
  auto idx = [nx](int x, int y) {return y * nx + x;};
  auto inside = [nx, ny](int x, int y) {return x >= 0 && y >= 0 && x < nx && y < ny;};
  if (!inside(sx, sy) || !inside(gx, gy)) {
    return std::nullopt;
  }

  // Start and goal may sit inside an inflated zone (pads next to buildings, drones displaced by a
  // new restriction). Search from them anyway: blocked cells are only entered when leaving the
  // start's or approaching the goal's blocked region.
  const std::size_t n = static_cast<std::size_t>(nx * ny);
  std::vector<double> g(n, std::numeric_limits<double>::infinity());
  std::vector<int> parent(n, -1);
  std::vector<std::uint8_t> closed(n, 0);
  using Item = std::pair<double, int>;
  std::priority_queue<Item, std::vector<Item>, std::greater<Item>> open;
  auto h = [&](int x, int y) {
      const double dx = std::abs(x - gx);
      const double dy = std::abs(y - gy);
      return (dx + dy) + (std::sqrt(2.0) - 2.0) * std::min(dx, dy);
    };
  const bool start_blocked = cell_blocked(r, sx, sy);
  const bool goal_blocked = cell_blocked(r, gx, gy);
  g[static_cast<std::size_t>(idx(sx, sy))] = 0.0;
  open.push({h(sx, sy), idx(sx, sy)});
  const int dxs[8] = {1, -1, 0, 0, 1, 1, -1, -1};
  const int dys[8] = {0, 0, 1, -1, 1, -1, 1, -1};
  bool found = false;
  std::size_t expansions = 0;
  while (!open.empty()) {
    const int cur = open.top().second;
    open.pop();
    if (closed[static_cast<std::size_t>(cur)] != 0) {
      continue;
    }
    closed[static_cast<std::size_t>(cur)] = 1;
    if (++expansions > n) {
      break;
    }
    const int cx = cur % nx;
    const int cy = cur / nx;
    if (cx == gx && cy == gy) {
      found = true;
      break;
    }
    const bool cur_blocked = cell_blocked(r, cx, cy);
    for (int k = 0; k < 8; ++k) {
      const int x = cx + dxs[k];
      const int y = cy + dys[k];
      if (!inside(x, y)) {
        continue;
      }
      const std::uint8_t level = cell_level(r, x, y);
      const bool blocked = level != 0;
      const bool near_goal = goal_blocked && std::abs(x - gx) + std::abs(y - gy) <=
        static_cast<int>(std::ceil(2 * config_.inflate_m / config_.cell_m)) + 2;
      const bool escaping = start_blocked && cur_blocked;
      // Hard cells (inside an obstacle) are only crossed while escaping one we started in; the
      // soft margin may also be crossed near the goal.
      const bool is_goal = x == gx && y == gy;
      if (level == 2 && !escaping && !is_goal) {
        continue;
      }
      if (blocked && !escaping && !near_goal && !is_goal) {
        continue;
      }
      // No corner cutting: a diagonal step needs both orthogonal neighbours free.
      if (k >= 4 && !escaping && !near_goal &&
        (cell_blocked(r, cx + dxs[k], cy) || cell_blocked(r, cx, cy + dys[k])))
      {
        continue;
      }
      const double step = (k < 4 ? 1.0 : std::sqrt(2.0)) * (blocked ? 4.0 : 1.0);
      const double ng = g[static_cast<std::size_t>(cur)] + step;
      const std::size_t ni = static_cast<std::size_t>(idx(x, y));
      if (ng < g[ni]) {
        g[ni] = ng;
        parent[ni] = cur;
        open.push({ng + h(x, y), idx(x, y)});
      }
    }
  }
  if (!found) {
    return std::nullopt;
  }
  std::vector<std::pair<double, double>> cells;
  for (int c = idx(gx, gy); c != -1; c = parent[static_cast<std::size_t>(c)]) {
    double x = 0.0;
    double y = 0.0;
    cell_centre(c % nx, c / nx, x, y);
    cells.emplace_back(x, y);
  }
  std::reverse(cells.begin(), cells.end());
  cells.front() = {a.x, a.y};
  cells.back() = {b.x, b.y};

  // Line-of-sight shortcutting (string pulling).
  std::vector<Vec3> path{a};
  std::size_t i = 0;
  while (i + 1 < cells.size()) {
    std::size_t j = cells.size() - 1;
    while (j > i + 1 && !line_clear(r, cells[i].first, cells[i].second, cells[j].first,
      cells[j].second))
    {
      --j;
    }
    path.push_back({cells[j].first, cells[j].second, cruise_alt});
    i = j;
  }
  return path;
}

}  // namespace aeropact::core
