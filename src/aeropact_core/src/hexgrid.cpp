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

#include "aeropact_core/hexgrid.hpp"

#include <cmath>
#include <cstdio>
#include <stdexcept>

namespace aeropact::core
{

HexGrid::HexGrid(double size_m)
: size_(size_m)
{
  if (size_m <= 0.0) {
    throw std::invalid_argument("hex size must be positive");
  }
}

void HexGrid::axial_of(double x, double y, int & q, int & r) const
{
  const double fq = (std::sqrt(3.0) / 3.0 * x - 1.0 / 3.0 * y) / size_;
  const double fr = (2.0 / 3.0 * y) / size_;
  const double fs = -fq - fr;
  double rq = std::round(fq);
  double rr = std::round(fr);
  const double rs = std::round(fs);
  const double dq = std::abs(rq - fq);
  const double dr = std::abs(rr - fr);
  const double ds = std::abs(rs - fs);
  if (dq > dr && dq > ds) {
    rq = -rr - rs;
  } else if (dr > ds) {
    rr = -rq - rs;
  }
  q = static_cast<int>(rq);
  r = static_cast<int>(rr);
}

std::string HexGrid::shard_of(double x, double y) const
{
  int q = 0;
  int r = 0;
  axial_of(x, y, q, r);
  return id(q, r);
}

geom::Vec2 HexGrid::center(int q, int r) const
{
  return {size_ * std::sqrt(3.0) * (q + r / 2.0), size_ * 1.5 * r};
}

std::string HexGrid::id(int q, int r)
{
  char buf[32];
  std::snprintf(buf, sizeof(buf), "H-%d-%d", q, r);
  return buf;
}

bool HexGrid::parse(const std::string & id, int & q, int & r)
{
  return std::sscanf(id.c_str(), "H-%d-%d", &q, &r) == 2;
}

}  // namespace aeropact::core
