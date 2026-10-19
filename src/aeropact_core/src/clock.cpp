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

#include "aeropact_core/clock.hpp"

#include <algorithm>

namespace aeropact::core
{

LocalClock::LocalClock(double drift_ppm, double offset_s)
: drift_ppm_(drift_ppm), anchor_local_(offset_s), last_local_(offset_s) {}

double LocalClock::now(double reference_time)
{
  if (!anchored_) {
    anchor_reference_ = reference_time;
    anchored_ = true;
  }
  const double elapsed = std::max(0.0, reference_time - anchor_reference_);
  const double local = anchor_local_ + elapsed * (1.0 + drift_ppm_ * 1e-6);
  last_local_ = std::max(last_local_, local);
  return last_local_;
}

void LocalClock::set_drift_ppm(double drift_ppm, double reference_time)
{
  const double current = now(reference_time);
  anchor_reference_ = reference_time;
  anchor_local_ = current;
  drift_ppm_ = drift_ppm;
}

}  // namespace aeropact::core
