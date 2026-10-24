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

#include <gtest/gtest.h>

#include <cmath>
#include <vector>

#include "aeropact_core/failure_detector.hpp"

using aeropact::core::FailureDetector;
using aeropact::core::FailureDetectorConfig;
using aeropact::core::PeerObservation;
using aeropact::core::PeerState;
using aeropact::core::ProbeRequest;

namespace
{

void beat(FailureDetector & fd, const std::string & id, double from, double to, double period)
{
  std::vector<ProbeRequest> probes;
  for (double t = from; t <= to; t += period) {
    fd.heartbeat(id, t, PeerObservation{});
    fd.update(t, probes);
  }
}

PeerState run_silence(FailureDetector & fd, double from, double to)
{
  std::vector<ProbeRequest> probes;
  for (double t = from; t <= to; t += 0.1) {
    fd.update(t, probes);
  }
  return fd.state("A02");
}

}  // namespace

TEST(FailureDetector, RegularHeartbeatsStayAlive)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 60, 1.0);
  EXPECT_EQ(fd.state("A02"), PeerState::kAlive);
  EXPECT_LT(fd.phi("A02"), 1.0);
}

TEST(FailureDetector, SilenceEscalatesThroughSuspectToUnreachable)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 30, 1.0);
  // A single lost heartbeat is tolerated.
  EXPECT_EQ(run_silence(fd, 30.1, 32.2), PeerState::kAlive);
  EXPECT_EQ(run_silence(fd, 32.3, 34.6), PeerState::kSuspect);
  EXPECT_EQ(run_silence(fd, 34.7, 40.0), PeerState::kUnreachable);
  // Silence alone, without quorum or evidence, never declares failure early.
  EXPECT_EQ(run_silence(fd, 40.1, 100.0), PeerState::kUnreachable);
}

TEST(FailureDetector, IndirectEvidenceKeepsPeerSuspectNotUnreachable)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 30, 1.0);
  beat(fd, "A03", 0, 30, 1.0);
  std::vector<ProbeRequest> probes;
  for (double t = 30.1; t <= 40.0; t += 0.1) {
    if (std::fmod(t, 1.0) < 0.1) {
      fd.heartbeat("A03", t, PeerObservation{});
    }
    fd.probe_ack("A02", true, 0.5, t);
    fd.update(t, probes);
  }
  EXPECT_EQ(fd.state("A02"), PeerState::kSuspect);
  bool probed = false;
  for (const auto & p : probes) {
    probed = probed || (p.target == "A02" && p.via == "A03");
  }
  EXPECT_TRUE(probed);
}

TEST(FailureDetector, QuorumWithEvidenceDeclaresFailure)
{
  FailureDetector fd("A01");
  PeerObservation dying;
  dying.soc = 0.05f;
  std::vector<ProbeRequest> probes;
  for (double t = 0; t <= 20; t += 1.0) {
    fd.heartbeat("A02", t, dying);
    fd.update(t, probes);
  }
  fd.vote_unreachable("A03", "A02", true, 30.0);
  EXPECT_EQ(run_silence(fd, 20.1, 32.0), PeerState::kDeclaredFailed);
}

TEST(FailureDetector, MinorityNeverDeclaresByQuorum)
{
  FailureDetector fd("A01");
  PeerObservation dying;
  dying.soc = 0.05f;
  std::vector<ProbeRequest> probes;
  for (double t = 0; t <= 20; t += 1.0) {
    fd.heartbeat("A02", t, dying);
    fd.update(t, probes, false);
  }
  fd.vote_unreachable("A03", "A02", true, 30.0);
  for (double t = 20.1; t <= 200.0; t += 0.5) {
    fd.update(t, probes, false);
  }
  EXPECT_EQ(fd.state("A02"), PeerState::kUnreachable);
}

TEST(FailureDetector, EnduranceBoundDeclaresWithoutCommunication)
{
  FailureDetectorConfig cfg;
  cfg.endurance_margin_s = 5.0;
  FailureDetector fd("A01", cfg);
  PeerObservation obs;
  obs.max_endurance_s = 20.0;
  std::vector<ProbeRequest> probes;
  for (double t = 0; t <= 10; t += 1.0) {
    fd.heartbeat("A02", t, obs);
    fd.update(t, probes);
  }
  EXPECT_EQ(run_silence(fd, 10.1, 34.0), PeerState::kUnreachable);
  EXPECT_EQ(run_silence(fd, 34.1, 40.0), PeerState::kDeclaredFailed);
}

TEST(FailureDetector, DistressDeclaresImmediately)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 5, 1.0);
  fd.distress("A02", 5.5);
  std::vector<ProbeRequest> probes;
  const auto tr = fd.update(5.6, probes);
  ASSERT_FALSE(tr.empty());
  EXPECT_EQ(tr.back().to, PeerState::kDeclaredFailed);
  EXPECT_EQ(tr.back().reason, "distress");
}

TEST(FailureDetector, HeardAgainRevivesADeclaredPeer)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 5, 1.0);
  fd.distress("A02", 5.5);
  std::vector<ProbeRequest> probes;
  fd.update(5.6, probes);
  ASSERT_EQ(fd.state("A02"), PeerState::kDeclaredFailed);
  fd.heartbeat("A02", 7.0, PeerObservation{});
  const auto tr = fd.update(7.0, probes);
  ASSERT_EQ(tr.size(), 1u);
  EXPECT_EQ(tr[0].reason, "revived");
  EXPECT_EQ(fd.state("A02"), PeerState::kAlive);
}

TEST(FailureDetector, RecoveryFromSuspectIsReported)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 20, 1.0);
  EXPECT_EQ(run_silence(fd, 20.1, 25.0), PeerState::kSuspect);
  fd.heartbeat("A02", 25.1, PeerObservation{});
  std::vector<ProbeRequest> probes;
  const auto tr = fd.update(25.1, probes);
  ASSERT_EQ(tr.size(), 1u);
  EXPECT_EQ(tr[0].to, PeerState::kAlive);
}

TEST(FailureDetector, MembershipSets)
{
  FailureDetector fd("A01");
  beat(fd, "A02", 0, 10, 1.0);
  EXPECT_EQ(fd.known().size(), 2u);
  EXPECT_EQ(fd.reachable().size(), 2u);
  run_silence(fd, 10.1, 30.0);
  EXPECT_EQ(fd.reachable().size(), 1u);
  EXPECT_EQ(fd.known().size(), 2u);
}

TEST(FailureDetector, PartitionUnawareAblationDeclaresOnTimeoutEvenInMinority)
{
  FailureDetectorConfig naive;
  naive.partition_aware = false;
  naive.naive_timeout_s = 30.0;
  FailureDetector fd("A01", naive);
  FailureDetector aware("A01");
  beat(fd, "A02", 0, 30, 1.0);
  beat(aware, "A02", 0, 30, 1.0);
  std::vector<ProbeRequest> probes;
  for (double t = 30.1; t <= 75.0; t += 0.1) {
    fd.update(t, probes, false);
    aware.update(t, probes, false);
  }
  // The baseline cannot tell a partition from a crash and takes over after the timeout;
  // PACT's detector, in a minority view, never declares on silence alone.
  EXPECT_EQ(fd.state("A02"), PeerState::kDeclaredFailed);
  EXPECT_EQ(aware.state("A02"), PeerState::kUnreachable);
}
