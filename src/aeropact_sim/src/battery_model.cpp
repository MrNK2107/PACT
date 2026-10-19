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

#include "aeropact_sim/battery_model.hpp"

#include <algorithm>
#include <cmath>

namespace aeropact::sim
{

BatteryModel::BatteryModel(BatteryParams p, double soc)
: p_(p), soc_(std::clamp(soc, 0.0, 1.0)) {}

void BatteryModel::step(
  double dt, bool airborne, const geom::Vec3 & velocity, const geom::Vec3 & wind,
  double payload_kg, bool charging)
{
  double power = p_.idle_power_w;
  if (airborne) {
    const geom::Vec3 air{velocity.x - wind.x, velocity.y - wind.y, 0.0};
    const double airspeed = geom::norm_xy(air);
    power = p_.hover_power_w + p_.speed_power_coeff * airspeed * airspeed +
      p_.payload_power_w_per_kg * std::max(0.0, payload_kg) +
      p_.climb_power_w * std::max(0.0, velocity.z) / 2.5;
  }
  soc_ -= power * p_.drain_factor * dt / (p_.capacity_wh * 3600.0);
  if (charging && !airborne) {
    soc_ += dt / p_.charge_time_s;
  }
  soc_ = std::clamp(soc_, 0.0, 1.0);
}

double BatteryModel::voltage() const
{
  // 4S LiPo, roughly linear between 13.2 V (empty) and 16.8 V (full).
  return 13.2 + 3.6 * soc_;
}

void BatteryModel::set_soc(double soc)
{
  soc_ = std::clamp(soc, 0.0, 1.0);
}

}  // namespace aeropact::sim
