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

#ifndef TEST_SUPPORT_HPP_
#define TEST_SUPPORT_HPP_

#include <random>
#include <string>
#include <vector>

#include "aeropact_core/types.hpp"

namespace aeropact::core::test
{

inline Task base_task(const std::string & id = "D1:00000001:0001")
{
  Task t;
  t.task_id = id;
  t.origin_depot = "D1";
  t.pickup = {0, 0, 0};
  t.drop = {300, 200, 0};
  t.priority = 2;
  t.deadline = 900;
  t.weight_kg = 1.0f;
  t.shard = "H-1-1";
  t.created_at = 10;
  return t;
}

/// Random but well-formed version of the same task (epoch >= claim_epoch, owner iff owned state).
inline Task random_version(std::mt19937_64 & rng, const Task & base)
{
  static const std::vector<std::string> owners{"A01", "A02", "A03", "A04"};
  std::uniform_int_distribution<int> st(0, 5);
  std::uniform_int_distribution<int> ep(0, 4);
  std::uniform_int_distribution<int> ow(0, 3);
  std::uniform_int_distribution<int> seq(0, 3);
  std::uniform_int_distribution<int> bid(0, 3);
  Task t = base;
  t.state = static_cast<TaskState>(st(rng));
  t.claim_epoch = static_cast<std::uint32_t>(ep(rng));
  t.epoch = t.claim_epoch + static_cast<std::uint32_t>(ep(rng) % 2);
  if (t.state != TaskState::kUnassigned) {
    t.owner = owners[static_cast<std::size_t>(ow(rng))];
    t.bid = 10.0 * bid(rng);
    t.lease_seq = static_cast<std::uint32_t>(seq(rng));
    t.lease_ttl = 20.0;
  }
  if (t.state == TaskState::kAborted) {
    t.abort_reason = "lost_in_flight";
  }
  return t;
}

}  // namespace aeropact::core::test

#endif  // TEST_SUPPORT_HPP_
