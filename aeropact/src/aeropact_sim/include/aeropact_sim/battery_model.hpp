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

#ifndef AEROPACT_SIM__BATTERY_MODEL_HPP_
#define AEROPACT_SIM__BATTERY_MODEL_HPP_

#include "aeropact_geometry/geometry.hpp"

namespace aeropact::sim
{

/// Ground-truth battery of the simulated vehicle. Deliberately not the planner's model: the
/// coefficients differ slightly, so the agents plan against an imperfect estimate.
struct BatteryParams
{
  double capacity_wh{60.0};
  double hover_power_w{240.0};
  double speed_power_coeff{1.3};
  double payload_power_w_per_kg{60.0};
  double climb_power_w{100.0};
  double idle_power_w{4.0};      ///< avionics on the ground
  double charge_time_s{240.0};   ///< empty to full on a powered pad (accelerated for scenarios)
  double drain_factor{1.0};      ///< fault: battery_drain multiplier
};

class BatteryModel
{
public:
  explicit BatteryModel(BatteryParams p = {}, double soc = 1.0);

  /// Integrate `dt` seconds. `airborne` selects flight or idle power; `charging` adds charge.
  void step(
    double dt, bool airborne, const geom::Vec3 & velocity, const geom::Vec3 & wind,
    double payload_kg, bool charging);

  double soc() const {return soc_;}
  bool depleted() const {return soc_ <= 0.0;}
  BatteryParams & params() {return p_;}
  double voltage() const;
  void set_soc(double soc);

private:
  BatteryParams p_;
  double soc_;
};

}  // namespace aeropact::sim

#endif  // AEROPACT_SIM__BATTERY_MODEL_HPP_
