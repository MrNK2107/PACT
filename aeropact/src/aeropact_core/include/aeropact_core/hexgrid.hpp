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

#ifndef AEROPACT_CORE__HEXGRID_HPP_
#define AEROPACT_CORE__HEXGRID_HPP_

#include <string>

#include "aeropact_geometry/geometry.hpp"

namespace aeropact::core
{

/// Pointy-top axial hex grid. Shard ids are "H-q-r" (PRD default shard size 500 m, configurable).
class HexGrid
{
public:
  explicit HexGrid(double size_m);

  double size() const {return size_;}
  std::string shard_of(double x, double y) const;
  void axial_of(double x, double y, int & q, int & r) const;
  geom::Vec2 center(int q, int r) const;
  static bool parse(const std::string & id, int & q, int & r);
  static std::string id(int q, int r);

private:
  double size_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__HEXGRID_HPP_
