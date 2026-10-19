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

#include "aeropact_core/task_ids.hpp"

#include <algorithm>
#include <cinttypes>
#include <cstdio>

namespace aeropact::core
{

std::uint64_t HybridLogicalClock::tick(double local_time_s)
{
  const auto physical = static_cast<std::uint64_t>(std::max(0.0, local_time_s) * 1000.0);
  last_ = std::max(last_ + 1, physical);
  return last_;
}

void HybridLogicalClock::observe(std::uint64_t remote)
{
  last_ = std::max(last_, remote);
}

std::string make_task_id(const std::string & depot, std::uint64_t hlc, std::uint32_t nonce)
{
  char buf[64];
  std::snprintf(buf, sizeof(buf), ":%08" PRIu64 ":%04x", hlc, nonce & 0xffffU);
  return depot + buf;
}

}  // namespace aeropact::core
