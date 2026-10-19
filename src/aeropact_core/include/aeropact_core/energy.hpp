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

#ifndef AEROPACT_CORE__ENERGY_HPP_
#define AEROPACT_CORE__ENERGY_HPP_

#include "aeropact_core/types.hpp"

namespace aeropact::core
{

struct EnergyParams
{
  double battery_wh{60.0};
  double hover_power_w{230.0};        ///< electrical power in hover, no payload
  double speed_power_coeff{1.2};      ///< W per (m/s)^2 of airspeed (parasitic + profile)
  double payload_power_w_per_kg{55.0};
  double climb_power_w{90.0};         ///< extra power while climbing at nominal rate
  double cruise_speed{10.0};          ///< m/s
  double climb_rate{2.5};             ///< m/s
  double reserve_soc{0.20};           ///< PRD soc_reserve
  double pessimism{0.15};             ///< relative margin on every estimate
  double soc_sigma{0.05};             ///< absolute SOC sensing uncertainty (assumption T5)
  double consumption_factor{1.0};     ///< online calibration: observed / modelled consumption
};

/**
 * Battery and power model (REQ-ENG-001). A multirotor's electrical power is dominated by hover
 * power, grows with airspeed squared and with payload; wind changes the airspeed needed for a
 * given ground speed. Every planning query has a pessimistic variant used for commitment
 * decisions (I5).
 */
class EnergyModel
{
public:
  explicit EnergyModel(EnergyParams params = {});

  const EnergyParams & params() const {return p_;}
  void set_consumption_factor(double f) {p_.consumption_factor = f;}

  double power_w(double airspeed, double payload_kg) const;

  /// SOC fraction spent flying from `a` to `b` at cruise speed with `payload_kg`, including the
  /// vertical legs to and from cruise altitude when `with_vertical` is true.
  double soc_for_leg(
    const Vec3 & a, const Vec3 & b, double payload_kg, const Vec3 & wind, double cruise_alt,
    bool with_vertical) const;

  double soc_for_hover(double seconds, double payload_kg) const;
  double flight_time_s(const Vec3 & a, const Vec3 & b, const Vec3 & wind, double cruise_alt) const;

  /// Pessimistic version of a consumption estimate.
  double pessimistic(double soc) const;

  /// True when spending `required` (nominal) and then `to_pad` (nominal) keeps the reserve.
  bool feasible(double soc_now, double required, double to_pad) const;

  /// Upper bound on remaining flight time: hover with no payload until empty.
  double max_endurance_s(double soc) const;

private:
  EnergyParams p_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__ENERGY_HPP_
