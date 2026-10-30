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

#ifndef AEROPACT_CORE__AUCTION_HPP_
#define AEROPACT_CORE__AUCTION_HPP_

#include <cstddef>
#include <string>
#include <vector>

#include "aeropact_core/energy.hpp"
#include "aeropact_core/types.hpp"
#include "aeropact_core/world_model.hpp"

namespace aeropact::core
{

struct AuctionWeights
{
  double priority{120.0};     ///< per priority level above "low"
  double distance{0.06};      ///< per metre of extra route
  double energy{150.0};       ///< per unit of extra SOC
  double lateness{1.0};       ///< per second of expected lateness
  double risk{40.0};          ///< per no-fly zone the straight route crosses
  double pad_contention{25.0};  ///< per live reservation per pad at the destination depot
};

struct AuctionConfig
{
  std::size_t bundle_len{3};
  AuctionWeights weights;
  double cruise_alt{35.0};
  double handling_time_s{15.0};  ///< loading or dropping a parcel
  bool use_charging_penalty{true};
};

/// What the bidder knows about itself when it builds a bundle.
struct BidderState
{
  std::string id;
  Vec3 position;
  double soc{1.0};
  double capacity_kg{2.0};
  double fleet_now{0.0};          ///< fleet time base (s)
  std::vector<Task> bundle;       ///< tasks already held, in execution order
};

struct Bid
{
  Task task;
  double score{0.0};
  std::size_t position{0};
};

/**
 * Consensus-based bundle auction, bundle phase (03 section 3.4, REQ-AUC-001/004/005).
 * One parcel at a time: a bundle is an ordered list of tasks, each flown pickup -> drop.
 * Bids are marginal scores of inserting a task at its best position, subject to payload,
 * energy-reserve (I5) and no-fly constraints.
 */
class Auction
{
public:
  Auction(AuctionConfig config, const EnergyModel & energy, const WorldModel & world);

  const AuctionConfig & config() const {return config_;}

  /// Greedy bundle build: new bids (beyond the current bundle) in the order they were added.
  std::vector<Bid> build_bundle(
    const BidderState & me, const std::vector<Task> & candidates,
    const std::vector<PadReservation> & reservations) const;

  /// Score of inserting `task` into `bundle` at `pos`; returns false when infeasible.
  bool score_insertion(
    const BidderState & me, const std::vector<Task> & bundle, const Task & task, std::size_t pos,
    const std::vector<PadReservation> & reservations, double & score) const;

  /// Totals for flying `bundle` from `start`: distance (m), SOC, finish times per task.
  struct RouteEstimate
  {
    double distance{0.0};
    double soc{0.0};
    double to_pad_soc{0.0};
    std::vector<double> finish_times;
  };
  RouteEstimate estimate(
    const Vec3 & start, const std::vector<Task> & bundle, double fleet_now) const;

  /// Number of active no-fly zones the straight path a-b crosses.
  int crossings(const Vec3 & a, const Vec3 & b) const;

private:
  AuctionConfig config_;
  const EnergyModel & energy_;
  const WorldModel & world_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__AUCTION_HPP_
