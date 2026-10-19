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

#ifndef AEROPACT_CORE__TYPES_HPP_
#define AEROPACT_CORE__TYPES_HPP_

#include <cstdint>
#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"

namespace aeropact::core
{

using geom::Vec3;

/// Task life cycle. Values match aeropact_interfaces/msg/TaskRecord STATE_* constants.
enum class TaskState : std::uint8_t
{
  kUnassigned = 0,
  kClaimed = 1,
  kCommitted = 2,
  kPickedUp = 3,
  kAborted = 4,
  kDelivered = 5,
};

/// PRD rank: UNASSIGNED(0) < CLAIMED(1) < COMMITTED(2) < PICKED_UP(3) < DELIVERED(4) | ABORTED(4).
int state_rank(TaskState s);

/// Progress class used by the merge: 0 before pickup, 1 picked up, 2 aborted, 3 delivered.
int progress_class(TaskState s);

bool is_terminal(TaskState s);
bool is_pre_pickup(TaskState s);
const char * to_string(TaskState s);

struct Task
{
  std::string task_id;
  std::string origin_depot;
  Vec3 pickup;
  Vec3 drop;
  std::uint8_t priority{3};
  double deadline{0.0};
  float weight_kg{0.0f};
  std::string shard;
  TaskState state{TaskState::kUnassigned};
  std::uint32_t epoch{0};
  std::uint32_t claim_epoch{0};
  std::string owner;
  double bid{0.0};
  double lease_ttl{0.0};
  std::uint32_t lease_seq{0};
  double created_at{0.0};
  std::string replaces;
  std::string abort_reason;

  bool operator==(const Task & o) const;
  bool operator!=(const Task & o) const {return !(*this == o);}
};

enum class Health : std::uint8_t { kOk = 0, kDegraded = 1, kFailed = 2 };
enum class LinkMode : std::uint8_t { kConnected = 0, kDegraded = 1, kPartitioned = 2, kSolo = 3 };
enum class Activity : std::uint8_t
{
  kIdle = 0,
  kToPickup = 1,
  kLoading = 2,
  kToDrop = 3,
  kDropping = 4,
  kToPad = 5,
  kCharging = 6,
  kHolding = 7,
  kSafetyOverride = 8,
  kLanded = 9,
};

const char * to_string(LinkMode m);
const char * to_string(Activity a);

struct DroneInfo
{
  std::string drone_id;
  std::uint64_t seq{0};
  Vec3 position;
  Vec3 velocity;
  float soc{1.0f};
  float capacity_kg{2.0f};
  Health health{Health::kOk};
  LinkMode mode{LinkMode::kConnected};
  Activity activity{Activity::kIdle};
  std::vector<std::string> bundle;
  std::vector<std::string> known_peers;
  double t_local{0.0};
};

struct PadReservation
{
  std::string tag;
  std::string pad_id;
  std::string depot_id;
  std::string drone_id;
  double window_start{0.0};
  double window_end{0.0};
  std::uint32_t epoch{0};
};

struct ShardLease
{
  std::string shard_id;
  std::string holder;
  std::uint32_t epoch{0};
  std::uint32_t lease_seq{0};
  double lease_ttl{0.0};
};

/// Partition policies (03 section 3.5(f)).
enum class PartitionPolicyKind : std::uint8_t { kStrict = 0, kQuorum = 1, kOptimisticBounded = 2 };
PartitionPolicyKind partition_policy_from_string(const std::string & s);
const char * to_string(PartitionPolicyKind k);

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__TYPES_HPP_
