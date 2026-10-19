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

#ifndef AEROPACT_SIM__CHANNEL_MODEL_HPP_
#define AEROPACT_SIM__CHANNEL_MODEL_HPP_

#include <cstdint>
#include <map>
#include <random>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_geometry/geometry.hpp"

namespace aeropact::sim
{

struct ChannelConfig
{
  double range_m{1500.0};
  double base_loss{0.02};
  double latency_min_s{0.05};
  double latency_max_s{0.25};
  double range_loss_knee{0.7};  ///< beyond this fraction of the range loss rises linearly to 1
};

/// Result of a delivery attempt on one directed link.
struct LinkDecision
{
  bool delivered{false};
  double latency_s{0.0};
  const char * drop_reason{""};
};

/**
 * Broadcast radio channel (assumption T3, REQ-SIM-003): range cutoff with distance-dependent loss,
 * per-node link loss, global loss, latency distribution, scripted partitions (by node groups) and
 * asymmetric (one-way) link failures, each with an optional end time. Seeded and deterministic for
 * a given sequence of calls.
 */
class ChannelModel
{
public:
  explicit ChannelModel(ChannelConfig config = {}, std::uint64_t seed = 1);

  LinkDecision decide(
    const std::string & src, const geom::Vec3 & src_pos,
    const std::string & dst, const geom::Vec3 & dst_pos, double now);

  /// Partition the listed groups from each other until `until` (< 0: indefinitely). Nodes not
  /// listed form their own group.
  void partition(const std::vector<std::set<std::string>> & groups, double until);
  void heal();
  void set_node_loss(const std::string & node, double loss, double until);
  void set_global_loss(double loss, double until);
  void block_direction(const std::string & from, const std::string & to, double until);
  void expire(double now);

  bool partitioned(const std::string & a, const std::string & b) const;
  const ChannelConfig & config() const {return config_;}
  void set_config(const ChannelConfig & c) {config_ = c;}

private:
  int group_of(const std::string & node) const;

  ChannelConfig config_;
  std::mt19937_64 rng_;
  std::vector<std::set<std::string>> groups_;
  double partition_until_{-1.0};
  std::map<std::string, std::pair<double, double>> node_loss_;  ///< node -> (loss, until)
  double global_loss_{-1.0};
  double global_loss_until_{-1.0};
  std::map<std::pair<std::string, std::string>, double> blocked_;  ///< (from, to) -> until
};

}  // namespace aeropact::sim

#endif  // AEROPACT_SIM__CHANNEL_MODEL_HPP_
