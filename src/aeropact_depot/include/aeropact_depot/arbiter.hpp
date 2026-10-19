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

#ifndef AEROPACT_DEPOT__ARBITER_HPP_
#define AEROPACT_DEPOT__ARBITER_HPP_

#include <cstdint>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "aeropact_core/types.hpp"

namespace aeropact::depot
{

enum class PickupResult : std::uint8_t
{
  kGrant = 0,
  kTaskTaken = 1,
  kStaleEpoch = 2,
  kNotAtBay = 3,
  kUnknownTask = 4,
  kDepotOffline = 5,
};

/**
 * Physical parcel hand-off (03 section 3.5(b),(e); REQ-OWN-003). There is one parcel per task id
 * in the depot: it can be handed to one drone only. With arbitration enabled the depot also checks
 * the fencing token: a request whose epoch is older than the newest epoch the depot has seen for
 * the task is refused (zombie owner), as is a request from a drone that is not the owner known to
 * the depot unless its epoch is newer than anything the depot knows (the depot may lag behind the
 * gossip). With arbitration disabled (cbba_plain / greedy ablation) every request gets a parcel,
 * which models a depot that simply loads whichever drone shows up.
 */
class ParcelArbiter
{
public:
  explicit ParcelArbiter(bool arbitration = true)
  : arbitration_(arbitration) {}

  PickupResult request(
    const core::Task * known, const std::string & task_id,
    const std::string & drone_id, std::uint32_t epoch);

  bool handed(const std::string & task_id) const {return handed_.count(task_id) != 0U;}
  std::size_t parcels_handed() const {return parcels_;}

private:
  bool arbitration_;
  std::map<std::string, std::string> handed_;  ///< task id -> drone holding the parcel
  std::size_t parcels_{0};
};

struct PadState
{
  std::string id;
  core::Vec3 position;
  bool powered{true};
  std::string holder;
  std::string tag;
  double granted_at{-1.0};
  bool visited{false};  ///< the holder has been on the pad since the grant
};

/**
 * Charging-pad arbiter (REQ-ENG-003): one holder per pad; a drone keeps its own pad, otherwise
 * gets the first free powered pad (deterministic order by pad id). Outages free nothing: a drone
 * sitting on a pad that loses power keeps the pad but stops charging.
 */
class PadArbiter
{
public:
  void add_pad(const std::string & id, const core::Vec3 & position);
  std::optional<PadState> reserve(const std::string & drone_id, double now = 0.0);
  /// Ground-truth occupancy: frees a pad whose holder used it and left, or never came. Returns
  /// the freed pad ids. Keeps pads from leaking when a radio release cannot reach the depot.
  std::vector<std::string> observe(
    const std::string & drone, const core::Vec3 & pos, double now,
    double unused_timeout = 300.0);
  bool release(const std::string & drone_id, const std::string & pad_id);
  void assign(const std::string & drone_id, const std::string & pad_id);
  void set_powered(const std::string & pad_id, bool powered);
  void set_all_powered(bool powered);
  const std::map<std::string, PadState> & pads() const {return pads_;}
  std::size_t free_powered() const;

private:
  std::map<std::string, PadState> pads_;
};

struct Bay
{
  std::string id;
  core::Vec3 position;
  std::string holder;
  double granted_at{-1.0};
  bool visited{false};  ///< the holder has been at the bay since the grant
};

/**
 * Hand-off bay arbiter: one drone per bay. A drone keeps its bay until the depot sees it leave
 * (ground truth: more than `leave_radius` away after having been at the bay) or the grant times
 * out unused. This keeps arriving drones from stacking over the same point.
 */
class BayArbiter
{
public:
  void add_bay(const std::string & id, const core::Vec3 & position);
  /// Bay held by or granted to `drone`, or nullopt when all bays are busy.
  std::optional<Bay> reserve(const std::string & drone, double now);
  /// Update occupancy from a drone's ground-truth position; returns ids of bays freed.
  std::vector<std::string> observe(
    const std::string & drone, const core::Vec3 & pos, double now,
    double at_radius, double leave_radius, double unused_timeout);
  /// Bay held by `drone`, if any.
  const Bay * held_by(const std::string & drone) const;
  const std::vector<Bay> & bays() const {return bays_;}

private:
  std::vector<Bay> bays_;
};

}  // namespace aeropact::depot

#endif  // AEROPACT_DEPOT__ARBITER_HPP_
