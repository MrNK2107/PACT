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

#include <random>

#include "aeropact_sim/channel_model.hpp"
#include "aeropact_sim/yaml_json.hpp"

using aeropact::geom::Vec3;
using aeropact::sim::ChannelConfig;
using aeropact::sim::ChannelModel;

TEST(ChannelModel, RangeCutoff)
{
  ChannelConfig c;
  c.range_m = 100;
  c.base_loss = 0.0;
  ChannelModel m(c, 1);
  EXPECT_TRUE(m.decide("A", {0, 0, 0}, "B", {50, 0, 0}, 0).delivered);
  EXPECT_FALSE(m.decide("A", {0, 0, 0}, "B", {150, 0, 0}, 0).delivered);
}

// TC-02 acceptance: measured loss and latency within tolerance of the configuration.
TEST(ChannelModel, LossAndLatencyStatistics)
{
  ChannelConfig c;
  c.base_loss = 0.2;
  c.latency_min_s = 0.05;
  c.latency_max_s = 0.8;
  ChannelModel m(c, 7);
  int delivered = 0;
  double latency = 0.0;
  const int n = 20000;
  for (int i = 0; i < n; ++i) {
    const auto d = m.decide("A", {0, 0, 0}, "B", {10, 0, 0}, 0);
    if (d.delivered) {
      ++delivered;
      latency += d.latency_s;
      EXPECT_GE(d.latency_s, 0.05);
      EXPECT_LE(d.latency_s, 0.8);
    }
  }
  EXPECT_NEAR(1.0 - static_cast<double>(delivered) / n, 0.2, 0.015);
  EXPECT_NEAR(latency / delivered, 0.425, 0.02);
}

TEST(ChannelModel, PartitionsSeparateGroupsUntilHealed)
{
  ChannelConfig c;
  c.base_loss = 0.0;
  ChannelModel m(c, 1);
  m.partition({{"A", "B"}, {"C", "D"}}, 100.0);
  EXPECT_TRUE(m.decide("A", {}, "B", {}, 10).delivered);
  EXPECT_FALSE(m.decide("A", {}, "C", {}, 10).delivered);
  EXPECT_FALSE(m.decide("A", {}, "E", {}, 10).delivered);  // unlisted node is isolated
  m.expire(100.0);
  EXPECT_TRUE(m.decide("A", {}, "C", {}, 100).delivered);
}

TEST(ChannelModel, AsymmetricLinkBlocksOneDirection)
{
  ChannelConfig c;
  c.base_loss = 0.0;
  ChannelModel m(c, 1);
  m.block_direction("A", "B", -1.0);
  EXPECT_FALSE(m.decide("A", {}, "B", {}, 0).delivered);
  EXPECT_TRUE(m.decide("B", {}, "A", {}, 0).delivered);
}

TEST(ChannelModel, NodeLossIsolatesANode)
{
  ChannelConfig c;
  c.base_loss = 0.0;
  ChannelModel m(c, 1);
  m.set_node_loss("A", 1.0, 50.0);
  EXPECT_FALSE(m.decide("A", {}, "B", {}, 0).delivered);
  EXPECT_FALSE(m.decide("B", {}, "A", {}, 0).delivered);
  m.expire(50.0);
  EXPECT_TRUE(m.decide("B", {}, "A", {}, 51).delivered);
}

TEST(YamlJson, RoundTripsFaultArguments)
{
  const YAML::Node n = YAML::Load("{id: A05, groups: [[A01, A02], [A03]], until: 1200, ok: true}");
  const std::string j = aeropact::sim::to_json(n);
  EXPECT_NE(j.find("\"id\":\"A05\""), std::string::npos);
  EXPECT_NE(j.find("\"until\":1200"), std::string::npos);
  EXPECT_NE(j.find("[[\"A01\",\"A02\"],[\"A03\"]]"), std::string::npos);
  const YAML::Node back = aeropact::sim::parse_args(j);
  EXPECT_EQ(back["groups"][0][1].as<std::string>(), "A02");
  EXPECT_TRUE(aeropact::sim::parse_args("not: [valid").IsMap());
}
