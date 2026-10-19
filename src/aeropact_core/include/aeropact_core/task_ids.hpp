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

#ifndef AEROPACT_CORE__TASK_IDS_HPP_
#define AEROPACT_CORE__TASK_IDS_HPP_

#include <cstdint>
#include <string>

namespace aeropact::core
{

/**
 * Hybrid logical clock for globally unique task ids "<depot>:<hlc>:<nonce>" (03 section 3.9).
 * The physical part is milliseconds of the node's local clock; the logical part breaks ties.
 */
class HybridLogicalClock
{
public:
  std::uint64_t tick(double local_time_s);
  void observe(std::uint64_t remote);

private:
  std::uint64_t last_{0};
};

std::string make_task_id(const std::string & depot, std::uint64_t hlc, std::uint32_t nonce);

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__TASK_IDS_HPP_
