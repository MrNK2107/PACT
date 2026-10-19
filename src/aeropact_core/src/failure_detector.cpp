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

#include "aeropact_core/failure_detector.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <utility>

namespace aeropact::core
{

const char * to_string(PeerState s)
{
  switch (s) {
    case PeerState::kAlive: return "ALIVE";
    case PeerState::kSuspect: return "SUSPECT";
    case PeerState::kUnreachable: return "UNREACHABLE";
    case PeerState::kDeclaredFailed: return "DECLARED_FAILED";
  }
  return "UNKNOWN";
}

FailureDetector::FailureDetector(std::string self, FailureDetectorConfig config)
: self_(std::move(self)), config_(config) {}

void FailureDetector::heartbeat(
  const std::string & id, double now_local, const PeerObservation & obs)
{
  if (id == self_) {
    return;
  }
  Peer & p = peers_[id];
  p.id = id;
  if (p.last_heard >= 0.0) {
    const double dt = now_local - p.last_heard;
    if (dt > 1e-3) {
      p.intervals.push_back(dt);
      while (p.intervals.size() > config_.window) {
        p.intervals.pop_front();
      }
    }
  } else {
    p.first_heard = now_local;
  }
  p.last_heard = now_local;
  p.last = obs;
  p.evidence = obs.health == Health::kFailed || obs.soc < 0.08 || obs.vertical_speed < -3.0;
  p.unreachable_votes.clear();
  // The state itself is re-evaluated (and the transition reported) by the next update().
}

void FailureDetector::distress(const std::string & id, double)
{
  if (id == self_) {
    return;
  }
  Peer & p = peers_[id];
  p.id = id;
  p.distress = true;
}

void FailureDetector::vote_unreachable(
  const std::string & observer, const std::string & target, bool physical_evidence,
  double now_local)
{
  if (target == self_) {
    return;
  }
  auto it = peers_.find(target);
  if (it == peers_.end()) {
    return;
  }
  it->second.unreachable_votes[observer] = now_local;
  it->second.evidence = it->second.evidence || physical_evidence;
}

void FailureDetector::probe_ack(
  const std::string & target, bool heard_recently, double last_heard_age, double now_local)
{
  auto it = peers_.find(target);
  if (it == peers_.end() || !heard_recently) {
    return;
  }
  Peer & p = it->second;
  p.indirect_alive_until = std::max(
    p.indirect_alive_until, now_local - last_heard_age + config_.indirect_alive_s);
}

void FailureDetector::remove(const std::string & id)
{
  peers_.erase(id);
}

double FailureDetector::compute_phi(const Peer & p, double now_local) const
{
  if (p.last_heard < 0.0) {
    return 0.0;
  }
  double mean = config_.first_interval_s;
  double stdev = config_.min_std_s;
  if (!p.intervals.empty()) {
    const double n = static_cast<double>(p.intervals.size());
    mean = std::accumulate(p.intervals.begin(), p.intervals.end(), 0.0) / n;
    double var = 0.0;
    for (double v : p.intervals) {
      var += (v - mean) * (v - mean);
    }
    stdev = std::max(config_.min_std_s, std::sqrt(var / n));
  }
  const double t = std::max(0.0, now_local - p.last_heard - config_.acceptable_pause_s);
  const double tail = 0.5 * std::erfc((t - mean) / (stdev * std::sqrt(2.0)));
  return -std::log10(std::max(tail, 1e-300));
}

std::vector<PeerTransition> FailureDetector::update(
  double now_local, std::vector<ProbeRequest> & probes, bool majority_view)
{
  std::vector<PeerTransition> out;
  // Candidate relays for indirect probes: alive peers, deterministic order.
  std::vector<std::string> relays;
  for (const auto & [id, p] : peers_) {
    if (p.state == PeerState::kAlive && p.last_heard >= 0.0) {
      relays.push_back(id);
    }
  }
  for (auto & [id, p] : peers_) {
    const PeerState before = p.state;
    if (before == PeerState::kDeclaredFailed) {
      // A declared-failed peer that is heard again is revived (declarations are conservative,
      // but never permanent if the peer proves otherwise).
      if (p.last_heard > p.declared_at) {
        p.state = PeerState::kAlive;
        p.distress = false;
        p.phi = 0.0;
        out.push_back({id, before, PeerState::kAlive, "revived"});
      }
      continue;
    }
    p.phi = compute_phi(p, now_local);
    const double age = p.last_heard < 0.0 ? 0.0 : now_local - p.last_heard;
    std::string reason;
    PeerState next = PeerState::kAlive;
    if (p.phi > config_.phi_suspect) {
      next = PeerState::kSuspect;
    }
    const bool indirect_alive = config_.use_indirect_probing &&
      now_local < p.indirect_alive_until;
    if (p.phi > config_.phi_unreachable && !indirect_alive) {
      next = PeerState::kUnreachable;
    }
    // Ask k relays whether they still hear the suspected peer. Once a peer is confirmed
    // unreachable the probing backs off: a long partition must not flood the mesh.
    const double probe_every = next == PeerState::kUnreachable ?
      config_.probe_interval_unreachable_s : config_.probe_interval_s;
    if (config_.use_indirect_probing && next != PeerState::kAlive &&
      now_local - p.last_probe >= probe_every)
    {
      p.last_probe = now_local;
      std::size_t sent = 0;
      for (const auto & r : relays) {
        if (r == id || sent >= config_.probe_fanout) {
          continue;
        }
        probes.push_back({r, id});
        ++sent;
      }
    }
    // Failure declaration.
    if (p.distress && p.last_heard >= 0.0) {
      next = PeerState::kDeclaredFailed;
      reason = "distress";
    } else if (next == PeerState::kUnreachable) {
      std::size_t observers = 1;  // self
      for (const auto & [obs, t] : p.unreachable_votes) {
        observers += (obs != self_ && now_local - t < 60.0) ? 1U : 0U;
      }
      const bool quorum = majority_view && observers >= config_.failure_quorum &&
        (p.evidence || age >= config_.quorum_min_age_s);
      const bool beyond_endurance = age > p.last.max_endurance_s + config_.endurance_margin_s;
      if (beyond_endurance) {
        next = PeerState::kDeclaredFailed;
        reason = "endurance_bound";
      } else if (quorum && !p.last.is_depot) {
        next = PeerState::kDeclaredFailed;
        reason = p.evidence ? "quorum_with_evidence" : "quorum_timeout";
      }
    }
    if (next != before) {
      p.state = next;
      if (next == PeerState::kDeclaredFailed) {
        p.declared_at = now_local;
      }
      out.push_back({id, before, next, reason});
    }
  }
  return out;
}

PeerState FailureDetector::state(const std::string & id) const
{
  auto it = peers_.find(id);
  return it == peers_.end() ? PeerState::kAlive : it->second.state;
}

double FailureDetector::phi(const std::string & id) const
{
  auto it = peers_.find(id);
  return it == peers_.end() ? 0.0 : it->second.phi;
}

double FailureDetector::last_heard_age(const std::string & id, double now_local) const
{
  auto it = peers_.find(id);
  if (it == peers_.end() || it->second.last_heard < 0.0) {
    return 1e9;
  }
  return now_local - it->second.last_heard;
}

std::set<std::string> FailureDetector::reachable() const
{
  std::set<std::string> out{self_};
  for (const auto & [id, p] : peers_) {
    if ((p.state == PeerState::kAlive || p.state == PeerState::kSuspect) && p.last_heard >= 0.0) {
      out.insert(id);
    }
  }
  return out;
}

std::set<std::string> FailureDetector::known() const
{
  std::set<std::string> out{self_};
  for (const auto & [id, p] : peers_) {
    if (p.state != PeerState::kDeclaredFailed && p.last_heard >= 0.0) {
      out.insert(id);
    }
  }
  return out;
}

bool FailureDetector::heard_recently(
  const std::string & id, double now_local, double window_s) const
{
  return last_heard_age(id, now_local) <= window_s;
}

}  // namespace aeropact::core
