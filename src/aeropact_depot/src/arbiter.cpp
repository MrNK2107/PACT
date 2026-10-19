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

#include "aeropact_depot/arbiter.hpp"

#include <algorithm>

namespace aeropact::depot
{

PickupResult ParcelArbiter::request(
  const core::Task * known, const std::string & task_id, const std::string & drone_id,
  std::uint32_t epoch)
{
  if (!arbitration_) {
    // No arbitration: every request is served with a (possibly duplicate) parcel.
    ++parcels_;
    handed_[task_id] = drone_id;
    return PickupResult::kGrant;
  }
  if (known == nullptr) {
    return PickupResult::kUnknownTask;
  }
  if (handed_.count(task_id) != 0U || !core::is_pre_pickup(known->state)) {
    return PickupResult::kTaskTaken;
  }
  if (epoch < known->epoch) {
    return PickupResult::kStaleEpoch;  // a newer fencing token exists: zombie owner
  }
  const bool owner_known = known->owner == drone_id && known->claim_epoch == epoch;
  const bool newer_than_known = epoch > known->claim_epoch;
  if (!owner_known && !newer_than_known) {
    return PickupResult::kTaskTaken;
  }
  handed_[task_id] = drone_id;
  ++parcels_;
  return PickupResult::kGrant;
}

void PadArbiter::add_pad(const std::string & id, const core::Vec3 & position)
{
  PadState p;
  p.id = id;
  p.position = position;
  pads_[id] = p;
}

std::optional<PadState> PadArbiter::reserve(const std::string & drone_id, double now)
{
  for (auto & [id, p] : pads_) {
    if (p.holder == drone_id) {
      return p;
    }
  }
  for (auto & [id, p] : pads_) {
    if (p.holder.empty() && p.powered) {
      p.holder = drone_id;
      p.granted_at = now;
      p.visited = false;
      return p;
    }
  }
  return std::nullopt;
}

std::vector<std::string> PadArbiter::observe(
  const std::string & drone, const core::Vec3 & pos, double now, double unused_timeout)
{
  std::vector<std::string> freed;
  for (auto & [id, p] : pads_) {
    if (p.holder != drone) {
      continue;
    }
    const double d = geom::dist_xy(pos, p.position);
    if (d < 3.0 && pos.z - p.position.z < 2.0) {
      p.visited = true;
    }
    const bool left = p.visited && (d > 30.0 || pos.z - p.position.z > 20.0);
    const bool unused = !p.visited && p.granted_at >= 0.0 && now - p.granted_at > unused_timeout;
    if (left || unused) {
      p.holder.clear();
      p.tag.clear();
      p.visited = false;
      freed.push_back(id);
    }
  }
  return freed;
}

bool PadArbiter::release(const std::string & drone_id, const std::string & pad_id)
{
  auto it = pads_.find(pad_id);
  if (it == pads_.end() || it->second.holder != drone_id) {
    return false;
  }
  it->second.holder.clear();
  it->second.tag.clear();
  return true;
}

void PadArbiter::assign(const std::string & drone_id, const std::string & pad_id)
{
  auto it = pads_.find(pad_id);
  if (it != pads_.end()) {
    it->second.holder = drone_id;
    it->second.visited = true;  // the drone starts on it
  }
}

void PadArbiter::set_powered(const std::string & pad_id, bool powered)
{
  auto it = pads_.find(pad_id);
  if (it != pads_.end()) {
    it->second.powered = powered;
  }
}

void PadArbiter::set_all_powered(bool powered)
{
  for (auto & [id, p] : pads_) {
    p.powered = powered;
  }
}

std::size_t PadArbiter::free_powered() const
{
  return static_cast<std::size_t>(std::count_if(pads_.begin(), pads_.end(),
         [](const auto & kv) {return kv.second.holder.empty() && kv.second.powered;}));
}

void BayArbiter::add_bay(const std::string & id, const core::Vec3 & position)
{
  Bay b;
  b.id = id;
  b.position = position;
  bays_.push_back(b);
}

std::optional<Bay> BayArbiter::reserve(const std::string & drone, double now)
{
  for (const auto & b : bays_) {
    if (b.holder == drone) {
      return b;
    }
  }
  for (auto & b : bays_) {
    if (b.holder.empty()) {
      b.holder = drone;
      b.granted_at = now;
      b.visited = false;
      return b;
    }
  }
  return std::nullopt;
}

std::vector<std::string> BayArbiter::observe(
  const std::string & drone, const core::Vec3 & pos, double now, double at_radius,
  double leave_radius, double unused_timeout)
{
  std::vector<std::string> freed;
  for (auto & b : bays_) {
    if (b.holder != drone) {
      continue;
    }
    const double d = geom::dist_xy(pos, b.position);
    if (d < at_radius && pos.z - b.position.z < 10.0) {
      b.visited = true;
    }
    const bool left = b.visited && (d > leave_radius || pos.z - b.position.z > 15.0);
    const bool unused = !b.visited && now - b.granted_at > unused_timeout;
    if (left || unused) {
      freed.push_back(b.id);
      b.holder.clear();
      b.visited = false;
    }
  }
  return freed;
}

const Bay * BayArbiter::held_by(const std::string & drone) const
{
  for (const auto & b : bays_) {
    if (b.holder == drone) {
      return &b;
    }
  }
  return nullptr;
}

}  // namespace aeropact::depot
