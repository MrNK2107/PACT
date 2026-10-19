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

#include "aeropact_core/energy.hpp"

#include <algorithm>
#include <cmath>

namespace aeropact::core
{

EnergyModel::EnergyModel(EnergyParams params)
: p_(params) {}

double EnergyModel::power_w(double airspeed, double payload_kg) const
{
  return p_.hover_power_w + p_.speed_power_coeff * airspeed * airspeed +
         p_.payload_power_w_per_kg * std::max(0.0, payload_kg);
}

double EnergyModel::flight_time_s(
  const Vec3 & a, const Vec3 & b, const Vec3 & wind, double cruise_alt) const
{
  const double d = geom::dist_xy(a, b);
  const double vertical = std::abs(cruise_alt - a.z) + std::abs(cruise_alt - b.z);
  double ground_speed = p_.cruise_speed;
  if (d > 1e-6) {
    // Tail/head wind component along the track changes the achieved ground speed.
    const double along = (wind.x * (b.x - a.x) + wind.y * (b.y - a.y)) / d;
    ground_speed = std::max(1.0, p_.cruise_speed + 0.5 * along);
  }
  return d / ground_speed + vertical / p_.climb_rate;
}

double EnergyModel::soc_for_leg(
  const Vec3 & a, const Vec3 & b, double payload_kg, const Vec3 & wind, double cruise_alt,
  bool with_vertical) const
{
  const double d = geom::dist_xy(a, b);
  double joules = 0.0;
  if (d > 1e-6) {
    const Vec3 dir{(b.x - a.x) / d, (b.y - a.y) / d, 0.0};
    const Vec3 ground_vel = dir * p_.cruise_speed;
    const Vec3 air_vel{ground_vel.x - wind.x, ground_vel.y - wind.y, 0.0};
    const double airspeed = geom::norm_xy(air_vel);
    joules += power_w(airspeed, payload_kg) * (d / p_.cruise_speed);
  }
  if (with_vertical) {
    const double climb = std::max(0.0, cruise_alt - a.z);
    const double descend = std::max(0.0, cruise_alt - b.z);
    joules += (power_w(0.0, payload_kg) + p_.climb_power_w) * climb / p_.climb_rate;
    joules += power_w(0.0, payload_kg) * descend / p_.climb_rate;
  }
  return p_.consumption_factor * joules / (p_.battery_wh * 3600.0);
}

double EnergyModel::soc_for_hover(double seconds, double payload_kg) const
{
  return p_.consumption_factor * power_w(0.0, payload_kg) * seconds / (p_.battery_wh * 3600.0);
}

double EnergyModel::pessimistic(double soc) const
{
  return soc * (1.0 + p_.pessimism);
}

bool EnergyModel::feasible(double soc_now, double required, double to_pad) const
{
  const double usable = soc_now - p_.soc_sigma;
  return usable - pessimistic(required + to_pad) >= p_.reserve_soc;
}

double EnergyModel::max_endurance_s(double soc) const
{
  return std::max(0.0, soc) * p_.battery_wh * 3600.0 /
         (p_.hover_power_w * 0.9 * std::max(0.1, p_.consumption_factor));
}

}  // namespace aeropact::core
