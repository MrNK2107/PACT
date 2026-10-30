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

#include "aeropact_sim/channel_model.hpp"

#include <algorithm>

namespace aeropact::sim
{

ChannelModel::ChannelModel(ChannelConfig config, std::uint64_t seed)
: config_(config), rng_(seed) {}

int ChannelModel::group_of(const std::string & node) const
{
  for (std::size_t i = 0; i < groups_.size(); ++i) {
    if (groups_[i].count(node) != 0U) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

bool ChannelModel::partitioned(const std::string & a, const std::string & b) const
{
  if (groups_.empty()) {
    return false;
  }
  const int ga = group_of(a);
  const int gb = group_of(b);
  // Unlisted nodes are isolated from every listed group but reach each other.
  return ga != gb;
}

LinkDecision ChannelModel::decide(
  const std::string & src, const geom::Vec3 & src_pos, const std::string & dst,
  const geom::Vec3 & dst_pos, double now)
{
  LinkDecision d;
  std::uniform_real_distribution<double> u(0.0, 1.0);
  // Always draw the same number of random numbers per decision, so that a fault on one link does
  // not shift the random stream of every other link.
  const double draw_loss = u(rng_);
  const double draw_latency = u(rng_);
  if (partitioned(src, dst)) {
    d.drop_reason = "partition";
    return d;
  }
  auto blk = blocked_.find({src, dst});
  if (blk != blocked_.end() && (blk->second < 0.0 || now < blk->second)) {
    d.drop_reason = "asymmetric";
    return d;
  }
  const double dist = geom::dist(src_pos, dst_pos);
  if (dist > config_.range_m) {
    d.drop_reason = "range";
    return d;
  }
  double keep = 1.0 - config_.base_loss;
  const double knee = config_.range_loss_knee * config_.range_m;
  if (dist > knee) {
    keep *= 1.0 - (dist - knee) / (config_.range_m - knee);
  }
  if (global_loss_ >= 0.0) {
    keep *= 1.0 - global_loss_;
  }
  for (const auto & n : {src, dst}) {
    auto it = node_loss_.find(n);
    if (it != node_loss_.end()) {
      keep *= 1.0 - it->second.first;
    }
  }
  if (draw_loss >= keep) {
    d.drop_reason = "loss";
    return d;
  }
  d.delivered = true;
  d.latency_s = config_.latency_min_s + draw_latency *
    (config_.latency_max_s - config_.latency_min_s);
  return d;
}

void ChannelModel::partition(const std::vector<std::set<std::string>> & groups, double until)
{
  groups_ = groups;
  partition_until_ = until;
}

void ChannelModel::heal()
{
  groups_.clear();
  partition_until_ = -1.0;
}

void ChannelModel::set_node_loss(const std::string & node, double loss, double until)
{
  node_loss_[node] = {std::clamp(loss, 0.0, 1.0), until};
}

void ChannelModel::set_global_loss(double loss, double until)
{
  global_loss_ = std::clamp(loss, 0.0, 1.0);
  global_loss_until_ = until;
}

void ChannelModel::block_direction(const std::string & from, const std::string & to, double until)
{
  blocked_[{from, to}] = until;
}

void ChannelModel::expire(double now)
{
  if (!groups_.empty() && partition_until_ >= 0.0 && now >= partition_until_) {
    heal();
  }
  for (auto it = node_loss_.begin(); it != node_loss_.end(); ) {
    it = (it->second.second >= 0.0 && now >= it->second.second) ? node_loss_.erase(it) :
      std::next(it);
  }
  if (global_loss_ >= 0.0 && global_loss_until_ >= 0.0 && now >= global_loss_until_) {
    global_loss_ = -1.0;
  }
  for (auto it = blocked_.begin(); it != blocked_.end(); ) {
    it = (it->second >= 0.0 && now >= it->second) ? blocked_.erase(it) : std::next(it);
  }
}

}  // namespace aeropact::sim
