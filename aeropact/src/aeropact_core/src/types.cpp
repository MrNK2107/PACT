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

#include "aeropact_core/types.hpp"

#include <stdexcept>

namespace aeropact::core
{

int state_rank(TaskState s)
{
  switch (s) {
    case TaskState::kUnassigned: return 0;
    case TaskState::kClaimed: return 1;
    case TaskState::kCommitted: return 2;
    case TaskState::kPickedUp: return 3;
    case TaskState::kAborted: return 4;
    case TaskState::kDelivered: return 4;
  }
  return 0;
}

int progress_class(TaskState s)
{
  switch (s) {
    case TaskState::kPickedUp: return 1;
    case TaskState::kAborted: return 2;
    case TaskState::kDelivered: return 3;
    default: return 0;
  }
}

bool is_terminal(TaskState s)
{
  return s == TaskState::kAborted || s == TaskState::kDelivered;
}

bool is_pre_pickup(TaskState s)
{
  return progress_class(s) == 0;
}

const char * to_string(TaskState s)
{
  switch (s) {
    case TaskState::kUnassigned: return "UNASSIGNED";
    case TaskState::kClaimed: return "CLAIMED";
    case TaskState::kCommitted: return "COMMITTED";
    case TaskState::kPickedUp: return "PICKED_UP";
    case TaskState::kAborted: return "ABORTED";
    case TaskState::kDelivered: return "DELIVERED";
  }
  return "UNKNOWN";
}

const char * to_string(LinkMode m)
{
  switch (m) {
    case LinkMode::kConnected: return "CONNECTED";
    case LinkMode::kDegraded: return "DEGRADED";
    case LinkMode::kPartitioned: return "PARTITIONED";
    case LinkMode::kSolo: return "SOLO";
  }
  return "UNKNOWN";
}

const char * to_string(Activity a)
{
  switch (a) {
    case Activity::kIdle: return "IDLE";
    case Activity::kToPickup: return "TO_PICKUP";
    case Activity::kLoading: return "LOADING";
    case Activity::kToDrop: return "TO_DROP";
    case Activity::kDropping: return "DROPPING";
    case Activity::kToPad: return "TO_PAD";
    case Activity::kCharging: return "CHARGING";
    case Activity::kHolding: return "HOLDING";
    case Activity::kSafetyOverride: return "SAFETY_OVERRIDE";
    case Activity::kLanded: return "LANDED";
  }
  return "UNKNOWN";
}

bool Task::operator==(const Task & o) const
{
  return task_id == o.task_id && origin_depot == o.origin_depot && pickup == o.pickup &&
         drop == o.drop && priority == o.priority && deadline == o.deadline &&
         weight_kg == o.weight_kg && shard == o.shard && state == o.state && epoch == o.epoch &&
         claim_epoch == o.claim_epoch && owner == o.owner && bid == o.bid &&
         lease_ttl == o.lease_ttl && lease_seq == o.lease_seq && created_at == o.created_at &&
         replaces == o.replaces && abort_reason == o.abort_reason;
}

PartitionPolicyKind partition_policy_from_string(const std::string & s)
{
  if (s == "STRICT" || s == "strict") {
    return PartitionPolicyKind::kStrict;
  }
  if (s == "QUORUM" || s == "quorum") {
    return PartitionPolicyKind::kQuorum;
  }
  if (s == "OPTIMISTIC_BOUNDED" || s == "optimistic_bounded" || s == "optimistic") {
    return PartitionPolicyKind::kOptimisticBounded;
  }
  throw std::invalid_argument("unknown partition policy: " + s);
}

const char * to_string(PartitionPolicyKind k)
{
  switch (k) {
    case PartitionPolicyKind::kStrict: return "STRICT";
    case PartitionPolicyKind::kQuorum: return "QUORUM";
    case PartitionPolicyKind::kOptimisticBounded: return "OPTIMISTIC_BOUNDED";
  }
  return "UNKNOWN";
}

}  // namespace aeropact::core
