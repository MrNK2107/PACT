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

#ifndef AEROPACT_CORE__MERGE_HPP_
#define AEROPACT_CORE__MERGE_HPP_

#include "aeropact_core/types.hpp"

namespace aeropact::core
{

/**
 * Total order on task versions. Returns > 0 when `a` wins, < 0 when `b` wins, 0 when equal.
 *
 * Key, compared lexicographically:
 *   1. progress class (pre-pickup < picked up < aborted < delivered): point of no return and
 *      absorbing terminal states;
 *   2. claim_epoch (the fencing token of the version);
 *   3. state rank;
 *   4. bid (CBBA consensus: higher bid wins within an epoch);
 *   5. owner, lower id wins (deterministic tie-break);
 *   6. lease_seq (renewals by the same owner);
 *   7. remaining mutable fields, so that the order is total and merge is idempotent.
 *
 * `epoch` is deliberately not part of the key: it is merged separately by max.
 */
int compare_task_versions(const Task & a, const Task & b);

/**
 * Join of two versions of the same task: the winning version with epoch = max(a.epoch, b.epoch).
 * Commutative, associative and idempotent (property-tested), so replicas converge under any
 * delivery order, loss or duplication (REQ-STATE-001).
 */
Task merge_task(const Task & a, const Task & b);

/// Drone status: last writer wins by sequence number (single writer per drone).
bool drone_newer(const DroneInfo & a, const DroneInfo & b);

/// Shard lease order: epoch, then lease_seq, then lower holder id. Returns > 0 when `a` wins.
int compare_shard_leases(const ShardLease & a, const ShardLease & b);

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__MERGE_HPP_
