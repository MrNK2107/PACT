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

#ifndef AEROPACT_CORE__FAILURE_DETECTOR_HPP_
#define AEROPACT_CORE__FAILURE_DETECTOR_HPP_

#include <cstddef>
#include <cstdint>
#include <deque>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "aeropact_core/types.hpp"

namespace aeropact::core
{

enum class PeerState : std::uint8_t
{
  kAlive = 0,
  kSuspect = 1,
  kUnreachable = 2,
  kDeclaredFailed = 3,
};
const char * to_string(PeerState s);

struct FailureDetectorConfig
{
  double phi_suspect{5.0};
  double phi_unreachable{9.0};
  std::size_t window{32};
  double min_std_s{0.5};
  double acceptable_pause_s{1.0};  ///< silence tolerated before suspicion grows (jitter)
  double first_interval_s{1.0};
  std::size_t failure_quorum{2};   ///< independent observers (including self)
  double quorum_min_age_s{60.0};   ///< without physical evidence, silence must last this long
  std::size_t probe_fanout{2};
  double probe_interval_s{3.0};
  double probe_interval_unreachable_s{20.0};
  double indirect_alive_s{6.0};    ///< an indirect "heard recently" keeps a peer from UNREACHABLE
  double endurance_margin_s{30.0};
  bool use_indirect_probing{true};
  /// Ablation for partition-unaware baselines: false declares any peer silent for
  /// naive_timeout_s failed on this node's own evidence (no quorum, no majority view).
  bool partition_aware{true};
  double naive_timeout_s{30.0};
};

struct PeerObservation
{
  Vec3 position;
  double soc{1.0};
  Health health{Health::kOk};
  double max_endurance_s{1e9};
  bool is_depot{false};
  double vertical_speed{0.0};
};

struct PeerTransition
{
  std::string id;
  PeerState from;
  PeerState to;
  std::string reason;
};

struct ProbeRequest
{
  std::string via;
  std::string target;
};

/**
 * Phi-accrual failure detector with indirect probing and a failure quorum
 * (03 section 3.6, REQ-FAIL-001..003). Distinguishes "dead" from "unreachable":
 *
 *   ALIVE -> SUSPECT        phi > phi_suspect: stop giving the peer new work
 *   SUSPECT -> UNREACHABLE  phi > phi_unreachable and no indirect evidence it is alive
 *   * -> DECLARED_FAILED    distress broadcast, OR failure quorum of observers (with physical
 *                           evidence, or after quorum_min_age), OR silence beyond the peer's own
 *                           maximum endurance (a physical bound needing no communication).
 * A heartbeat from a DECLARED_FAILED peer revives it (logged); declarations are conservative.
 */
class FailureDetector
{
public:
  struct Peer
  {
    std::string id;
    std::deque<double> intervals;
    double last_heard{-1.0};
    double first_heard{-1.0};
    double phi{0.0};
    PeerState state{PeerState::kAlive};
    PeerObservation last;
    double indirect_alive_until{-1.0};
    double last_probe{-1e9};
    bool distress{false};
    double declared_at{-1.0};
    std::map<std::string, double> unreachable_votes;  ///< observer -> local time of vote
    bool evidence{false};
  };

  explicit FailureDetector(std::string self, FailureDetectorConfig config = {});

  const FailureDetectorConfig & config() const {return config_;}

  void heartbeat(const std::string & id, double now_local, const PeerObservation & obs);
  void distress(const std::string & id, double now_local);
  void vote_unreachable(
    const std::string & observer, const std::string & target,
    bool physical_evidence, double now_local);
  void probe_ack(
    const std::string & target, bool heard_recently, double last_heard_age,
    double now_local);
  /// Forget a peer (e.g. a node removed from the fleet roster).
  void remove(const std::string & id);

  /// Advance phi and states; returns transitions. `probes` receives indirect probes to send.
  /// `majority_view`: this node currently reaches a majority of the membership. A minority cannot
  /// tell a dead peer from one on the other side of a partition, so quorum declarations require
  /// it; distress and the endurance bound (physically certain) do not.
  std::vector<PeerTransition> update(
    double now_local, std::vector<ProbeRequest> & probes, bool majority_view = true);

  PeerState state(const std::string & id) const;
  double phi(const std::string & id) const;
  double last_heard_age(const std::string & id, double now_local) const;
  const std::map<std::string, Peer> & peers() const {return peers_;}
  /// Peers in ALIVE or SUSPECT (still treated as reachable for membership), plus self.
  std::set<std::string> reachable() const;
  /// Every peer ever heard (not DECLARED_FAILED), plus self.
  std::set<std::string> known() const;
  bool heard_recently(const std::string & id, double now_local, double window_s) const;

private:
  double compute_phi(const Peer & p, double now_local) const;

  std::string self_;
  FailureDetectorConfig config_;
  std::map<std::string, Peer> peers_;
};

}  // namespace aeropact::core

#endif  // AEROPACT_CORE__FAILURE_DETECTOR_HPP_
