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

#include "aeropact_core/auction.hpp"

#include <algorithm>
#include <limits>

namespace aeropact::core
{

Auction::Auction(AuctionConfig config, const EnergyModel & energy, const WorldModel & world)
: config_(config), energy_(energy), world_(world) {}

int Auction::crossings(const Vec3 & a, const Vec3 & b) const
{
  int n = 0;
  for (const auto & z : world_.no_fly) {
    if (z.active && config_.cruise_alt >= z.floor_m && config_.cruise_alt <= z.ceiling_m &&
      geom::segment_intersects_polygon({a.x, a.y}, {b.x, b.y}, z.polygon))
    {
      ++n;
    }
  }
  return n;
}

Auction::RouteEstimate Auction::estimate(
  const Vec3 & start, const std::vector<Task> & bundle, double fleet_now) const
{
  RouteEstimate r;
  Vec3 pos = start;
  double t = fleet_now;
  // Straight-line legs with a detour factor for each no-fly crossing.
  auto leg = [&](const Vec3 & from, const Vec3 & to, double payload) {
      const double detour = 1.0 + 0.25 * crossings(from, to);
      r.distance += geom::dist_xy(from, to) * detour;
      r.soc += energy_.soc_for_leg(from, to, payload, world_.wind, config_.cruise_alt, true) *
        detour;
      t += energy_.flight_time_s(from, to, world_.wind, config_.cruise_alt) * detour;
    };
  for (const auto & task : bundle) {
    leg(pos, task.pickup, 0.0);
    t += config_.handling_time_s;
    r.soc += energy_.soc_for_hover(config_.handling_time_s, 0.0);
    leg(task.pickup, task.drop, task.weight_kg);
    t += config_.handling_time_s;
    r.soc += energy_.soc_for_hover(config_.handling_time_s, task.weight_kg);
    r.finish_times.push_back(t);
    pos = task.drop;
  }
  const Pad * pad = world_.nearest_pad(pos);
  if (pad != nullptr) {
    r.to_pad_soc = energy_.soc_for_leg(pos, pad->position, 0.0, world_.wind, config_.cruise_alt,
        true);
  }
  return r;
}

bool Auction::score_insertion(
  const BidderState & me, const std::vector<Task> & bundle, const Task & task, std::size_t pos,
  const std::vector<PadReservation> & reservations, double & score) const
{
  if (task.weight_kg > me.capacity_kg) {
    return false;
  }
  std::vector<Task> with = bundle;
  with.insert(with.begin() + static_cast<std::ptrdiff_t>(pos), task);
  const RouteEstimate base = estimate(me.position, bundle, me.fleet_now);
  const RouteEstimate next = estimate(me.position, with, me.fleet_now);
  if (!energy_.feasible(me.soc, next.soc, next.to_pad_soc)) {
    return false;  // reserve + reach-a-pad under the pessimistic estimate (I5)
  }
  const auto & w = config_.weights;
  double lateness = 0.0;
  for (std::size_t i = 0; i < with.size(); ++i) {
    lateness += std::max(0.0, next.finish_times[i] - with[i].deadline);
  }
  for (std::size_t i = 0; i < bundle.size(); ++i) {
    lateness -= std::max(0.0, base.finish_times[i] - bundle[i].deadline);
  }
  double contention = 0.0;
  if (config_.use_charging_penalty) {
    const Pad * pad = world_.nearest_pad(task.drop);
    if (pad != nullptr) {
      std::size_t pads_at = 0;
      std::size_t live = 0;
      for (const auto & p : world_.pads) {
        pads_at += p.depot_id == pad->depot_id ? 1U : 0U;
      }
      for (const auto & r : reservations) {
        live += (r.depot_id == pad->depot_id && r.drone_id != me.id) ? 1U : 0U;
      }
      contention = pads_at > 0 ? static_cast<double>(live) / static_cast<double>(pads_at) : 0.0;
    }
  }
  const double risk = crossings(task.pickup, task.drop);
  score = w.priority * (4.0 - static_cast<double>(task.priority)) -
    w.distance * (next.distance - base.distance) - w.energy * (next.soc - base.soc) -
    w.lateness * lateness - w.risk * risk - w.pad_contention * contention;
  return true;
}

std::vector<Bid> Auction::build_bundle(
  const BidderState & me, const std::vector<Task> & candidates,
  const std::vector<PadReservation> & reservations) const
{
  std::vector<Bid> added;
  std::vector<Task> bundle = me.bundle;
  std::vector<bool> used(candidates.size(), false);
  while (bundle.size() < config_.bundle_len) {
    double best = -std::numeric_limits<double>::infinity();
    std::size_t best_i = candidates.size();
    std::size_t best_pos = 0;
    for (std::size_t i = 0; i < candidates.size(); ++i) {
      if (used[i]) {
        continue;
      }
      // The first bundle slot is the one being flown; new tasks go after it.
      const std::size_t first = bundle.empty() ? 0 : 1;
      for (std::size_t pos = first; pos <= bundle.size(); ++pos) {
        double s = 0.0;
        if (!score_insertion(me, bundle, candidates[i], pos, reservations, s)) {
          continue;
        }
        // Must beat the standing bid (CBBA outbid rule); strict > keeps ties with the incumbent.
        const Task & c = candidates[i];
        if (c.state == TaskState::kClaimed && c.owner != me.id && !(s > c.bid)) {
          continue;
        }
        if (s > best || (s == best && best_i < candidates.size() &&
          c.task_id < candidates[best_i].task_id))
        {
          best = s;
          best_i = i;
          best_pos = pos;
        }
      }
    }
    if (best_i == candidates.size()) {
      break;
    }
    used[best_i] = true;
    bundle.insert(bundle.begin() + static_cast<std::ptrdiff_t>(best_pos), candidates[best_i]);
    added.push_back({candidates[best_i], best, best_pos});
  }
  return added;
}

}  // namespace aeropact::core
