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

#include "aeropact_core/merge.hpp"

#include <algorithm>

namespace aeropact::core
{
namespace
{

template<typename T>
int cmp(const T & a, const T & b)
{
  return (a < b) ? -1 : ((b < a) ? 1 : 0);
}

}  // namespace

int compare_task_versions(const Task & a, const Task & b)
{
  int c = cmp(progress_class(a.state), progress_class(b.state));
  if (c != 0) {return c;}
  c = cmp(a.claim_epoch, b.claim_epoch);
  if (c != 0) {return c;}
  c = cmp(state_rank(a.state), state_rank(b.state));
  if (c != 0) {return c;}
  c = cmp(a.bid, b.bid);
  if (c != 0) {return c;}
  c = cmp(b.owner, a.owner);  // lower owner id wins
  if (c != 0) {return c;}
  c = cmp(a.lease_seq, b.lease_seq);
  if (c != 0) {return c;}
  c = cmp(static_cast<int>(a.state), static_cast<int>(b.state));
  if (c != 0) {return c;}
  c = cmp(a.lease_ttl, b.lease_ttl);
  if (c != 0) {return c;}
  c = cmp(a.abort_reason, b.abort_reason);
  if (c != 0) {return c;}
  // Immutable intake fields are equal for honest writers; compare them so the order stays total.
  c = cmp(a.deadline, b.deadline);
  if (c != 0) {return c;}
  c = cmp(a.created_at, b.created_at);
  if (c != 0) {return c;}
  c = cmp(static_cast<int>(a.priority), static_cast<int>(b.priority));
  if (c != 0) {return c;}
  c = cmp(a.weight_kg, b.weight_kg);
  if (c != 0) {return c;}
  c = cmp(a.origin_depot, b.origin_depot);
  if (c != 0) {return c;}
  c = cmp(a.shard, b.shard);
  if (c != 0) {return c;}
  c = cmp(a.replaces, b.replaces);
  if (c != 0) {return c;}
  c = cmp(a.pickup.x, b.pickup.x);
  if (c != 0) {return c;}
  c = cmp(a.pickup.y, b.pickup.y);
  if (c != 0) {return c;}
  c = cmp(a.pickup.z, b.pickup.z);
  if (c != 0) {return c;}
  c = cmp(a.drop.x, b.drop.x);
  if (c != 0) {return c;}
  c = cmp(a.drop.y, b.drop.y);
  if (c != 0) {return c;}
  return cmp(a.drop.z, b.drop.z);
}

Task merge_task(const Task & a, const Task & b)
{
  Task out = compare_task_versions(a, b) >= 0 ? a : b;
  out.epoch = std::max({a.epoch, b.epoch, out.claim_epoch});
  return out;
}

bool drone_newer(const DroneInfo & a, const DroneInfo & b)
{
  return a.seq > b.seq;
}

int compare_shard_leases(const ShardLease & a, const ShardLease & b)
{
  int c = cmp(a.epoch, b.epoch);
  if (c != 0) {return c;}
  c = cmp(a.lease_seq, b.lease_seq);
  if (c != 0) {return c;}
  c = cmp(b.holder, a.holder);
  if (c != 0) {return c;}
  return cmp(a.lease_ttl, b.lease_ttl);
}

}  // namespace aeropact::core
