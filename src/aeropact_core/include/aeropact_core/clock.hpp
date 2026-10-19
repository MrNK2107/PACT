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

#ifndef AEROPACT_CORE__CLOCK_HPP_
#define AEROPACT_CORE__CLOCK_HPP_

namespace aeropact::core
{

/**
 * A node's local monotonic clock (assumption T4): it advances at (1 + ppm * 1e-6) times the rate
 * of an ideal reference and is never synchronised with other nodes. Ownership and lease logic use
 * only this clock (PRD 9.2 `Clock.now_local`). Changing the drift re-anchors the clock so that it
 * stays continuous and monotonic.
 */
class LocalClock
{
public:
  explicit LocalClock(double drift_ppm = 0.0, double offset_s = 0.0);

  /// Local time for a reference (simulation) time. Reference time must be non-decreasing.
  double now(double reference_time);

  void set_drift_ppm(double drift_ppm, double reference_time);
  double drift_ppm() const {return drift_ppm_;}

private:
  double drift_ppm_;
  double anchor_reference_{0.0};
  double anchor_local_;
  double last_local_;
  bool anchored_{false};
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__CLOCK_HPP_
