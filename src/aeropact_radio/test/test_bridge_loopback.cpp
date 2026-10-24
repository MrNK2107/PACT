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

// Two bridges on loopback UDP (unicast), plus an attacker socket: authenticated frames cross;
// forged, replayed and source-spoofed datagrams never reach the coordinator topic.

#include <gtest/gtest.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <fstream>
#include <limits>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "aeropact_radio/mesh_radio_bridge_node.hpp"
#include "lifecycle_msgs/msg/state.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp/serialization.hpp"

using aeropact::radio::MeshRadioBridgeNode;
using aeropact_interfaces::msg::RadioFrame;
namespace radio = aeropact::radio;

namespace
{

const char * kKey = "1:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff\n";

class BridgeLoopback : public ::testing::Test
{
protected:
  static void SetUpTestSuite() {rclcpp::init(0, nullptr);}
  static void TearDownTestSuite() {rclcpp::shutdown();}

  void SetUp() override
  {
    key_path_ = std::string(::testing::TempDir()) + "/aeropact_test_fleet.key";
    std::ofstream(key_path_) << kKey;
    a_ = make_bridge("A01", 47311, {"127.0.0.1:47312"});
    b_ = make_bridge("A02", 47312, {"127.0.0.1:47311"});
    for (auto & n : {a_, b_}) {
      ASSERT_EQ(n->configure().id(), lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE);
      ASSERT_EQ(n->activate().id(), lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE);
    }
    probe_ = std::make_shared<rclcpp::Node>("probe");
    tx_ = probe_->create_publisher<RadioFrame>("/A01/radio/tx", rclcpp::QoS(50).best_effort());
    rx_ = probe_->create_subscription<RadioFrame>(
      "/A02/radio/rx", rclcpp::QoS(50).best_effort(),
      [this](RadioFrame::ConstSharedPtr m) {received_.push_back(*m);});
    exec_.add_node(a_->get_node_base_interface());
    exec_.add_node(b_->get_node_base_interface());
    exec_.add_node(probe_);
    attacker_ = ::socket(AF_INET, SOCK_DGRAM, 0);
  }

  void TearDown() override
  {
    ::close(attacker_);
    for (auto & n : {a_, b_}) {
      n->deactivate();
      n->cleanup();
    }
  }

  std::shared_ptr<MeshRadioBridgeNode> make_bridge(
    const std::string & id, int port, const std::vector<std::string> & peers)
  {
    rclcpp::NodeOptions o;
    o.arguments({"--ros-args", "-r", "__ns:=/" + id});
    o.parameter_overrides({
        {"node_id", id}, {"key_file", key_path_}, {"mode", "unicast"}, {"port", port},
        {"peers", peers}});
    return std::make_shared<MeshRadioBridgeNode>(o);
  }

  void spin_for(double seconds)
  {
    const auto end = std::chrono::steady_clock::now() + std::chrono::duration<double>(seconds);
    while (std::chrono::steady_clock::now() < end) {
      exec_.spin_some(std::chrono::milliseconds(10));
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }

  RadioFrame heartbeat_from(const std::string & src, uint64_t seq)
  {
    RadioFrame f;
    f.version = RadioFrame::VERSION;
    f.type = RadioFrame::TYPE_HEARTBEAT;
    f.src = src;
    f.dst = "*";
    f.seq = seq;
    return f;
  }

  radio::Bytes payload(const RadioFrame & f)
  {
    rclcpp::Serialization<RadioFrame> s;
    rclcpp::SerializedMessage ser;
    s.serialize_message(&f, &ser);
    const auto & raw = ser.get_rcl_serialized_message();
    return radio::Bytes(raw.buffer, raw.buffer + raw.buffer_length);
  }

  void inject(const radio::Bytes & datagram, int port)
  {
    sockaddr_in dst{};
    dst.sin_family = AF_INET;
    dst.sin_port = htons(static_cast<uint16_t>(port));
    ::inet_pton(AF_INET, "127.0.0.1", &dst.sin_addr);
    ::sendto(attacker_, datagram.data(), datagram.size(), 0,
      reinterpret_cast<sockaddr *>(&dst), sizeof(dst));
  }

  std::string key_path_;
  std::shared_ptr<MeshRadioBridgeNode> a_;
  std::shared_ptr<MeshRadioBridgeNode> b_;
  rclcpp::Node::SharedPtr probe_;
  rclcpp::Publisher<RadioFrame>::SharedPtr tx_;
  rclcpp::Subscription<RadioFrame>::SharedPtr rx_;
  std::vector<RadioFrame> received_;
  rclcpp::executors::SingleThreadedExecutor exec_;
  int attacker_{-1};
};

}  // namespace

TEST_F(BridgeLoopback, AuthenticatedFramesCrossAndAttacksAreDropped)
{
  spin_for(0.5);  // discovery
  for (uint64_t i = 1; i <= 20; ++i) {
    tx_->publish(heartbeat_from("A01", i));
    spin_for(0.02);
  }
  spin_for(1.0);
  ASSERT_GE(received_.size(), 18U) << "authenticated frames should cross loopback";
  for (const auto & f : received_) {
    EXPECT_EQ(f.src, "A01");
  }
  const std::size_t legit = received_.size();

  // 1. Forgery: a well-formed envelope under the wrong secret.
  radio::FleetKey wrong;
  wrong.id = 1;
  wrong.secret.assign(32, 0x5A);
  radio::Envelope env;
  env.sender = "A03";
  env.counter = 1;
  env.payload = payload(heartbeat_from("A03", 1));
  inject(radio::encode(env, wrong), 47312);

  // 2. Replay: a genuine datagram (captured off the air) sent twice; then an old counter.
  radio::FleetKey fleet = radio::parse_key_file(kKey).front();
  env.sender = "A04";
  env.counter = 5000;
  env.payload = payload(heartbeat_from("A04", 1));
  const radio::Bytes captured = radio::encode(env, fleet);
  inject(captured, 47312);
  spin_for(0.3);
  inject(captured, 47312);
  env.counter = 10;
  inject(radio::encode(env, fleet), 47312);

  // 3. Source spoofing: authenticated sender A04 carrying a frame that claims to be from A01.
  env.counter = 6000;
  env.payload = payload(heartbeat_from("A01", 99));
  inject(radio::encode(env, fleet), 47312);

  // 4. Garbage.
  inject(radio::Bytes(100, 0xEE), 47312);
  spin_for(1.0);

  // Exactly one extra frame (the first copy of the genuine A04 datagram) got through.
  ASSERT_EQ(received_.size(), legit + 1);
  EXPECT_EQ(received_.back().src, "A04");
}

TEST_F(BridgeLoopback, OnlyTheNodesOwnFramesLeaveThroughItsBridge)
{
  spin_for(0.5);
  tx_->publish(heartbeat_from("A07", 1));  // not A01's frame: a bridge never relays it
  spin_for(1.0);
  EXPECT_TRUE(received_.empty());
}

// Ed25519 mode (D-30): two bridges with per-node keys; an attacker holding a stolen node key
// can speak only as that node, and a revoked node not at all.
class BridgeSigned : public ::testing::Test
{
protected:
  static void SetUpTestSuite() {rclcpp::init(0, nullptr);}
  static void TearDownTestSuite() {rclcpp::shutdown();}
};

TEST_F(BridgeSigned, PerNodeKeysStopImpersonation)
{
  const std::string dir = ::testing::TempDir();
  const auto a01 = radio::generate_signing_key();
  const auto a02 = radio::generate_signing_key();
  const auto a04 = radio::generate_signing_key();  // stolen; A04 is not in the roster (revoked)
  std::ofstream(dir + "/a01.key") << radio::to_hex(a01.seed) << "\n";
  std::ofstream(dir + "/a02.key") << radio::to_hex(a02.seed) << "\n";
  std::ofstream(dir + "/roster") << "A01:" << radio::to_hex(a01.public_key) << "\nA02:"
                                 << radio::to_hex(a02.public_key) << "\n";
  auto make = [&dir](const std::string & id, int port, const std::string & peer) {
      rclcpp::NodeOptions o;
      o.arguments({"--ros-args", "-r", "__ns:=/" + id});
      o.parameter_overrides({
      {"node_id", id}, {"auth", "ed25519"},
      {"private_key_file", dir + "/" + (id == "A01" ? "a01" : "a02") + ".key"},
      {"public_keys_file", dir + "/roster"}, {"mode", "unicast"}, {"port", port},
      {"peers", std::vector<std::string>{peer}}});
      return std::make_shared<MeshRadioBridgeNode>(o);
    };
  auto a = make("A01", 47321, "127.0.0.1:47322");
  auto b = make("A02", 47322, "127.0.0.1:47321");
  for (auto & n : {a, b}) {
    ASSERT_EQ(n->configure().id(), lifecycle_msgs::msg::State::PRIMARY_STATE_INACTIVE);
    ASSERT_EQ(n->activate().id(), lifecycle_msgs::msg::State::PRIMARY_STATE_ACTIVE);
  }
  auto probe = std::make_shared<rclcpp::Node>("probe_signed");
  auto tx = probe->create_publisher<RadioFrame>("/A01/radio/tx", rclcpp::QoS(50).best_effort());
  std::vector<RadioFrame> got;
  auto rx = probe->create_subscription<RadioFrame>("/A02/radio/rx",
      rclcpp::QoS(50).best_effort(), [&got](RadioFrame::ConstSharedPtr m) {got.push_back(*m);});
  rclcpp::executors::SingleThreadedExecutor exec;
  exec.add_node(a->get_node_base_interface());
  exec.add_node(b->get_node_base_interface());
  exec.add_node(probe);
  auto spin = [&exec](double s) {
      const auto end = std::chrono::steady_clock::now() + std::chrono::duration<double>(s);
      while (std::chrono::steady_clock::now() < end) {
        exec.spin_some(std::chrono::milliseconds(10));
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
      }
    };
  spin(0.5);
  RadioFrame hb;
  hb.version = RadioFrame::VERSION;
  hb.type = RadioFrame::TYPE_HEARTBEAT;
  hb.src = "A01";
  hb.dst = "*";
  for (int i = 0; i < 10; ++i) {
    tx->publish(hb);
    spin(0.03);
  }
  spin(1.0);
  ASSERT_GE(got.size(), 8U) << "signed frames should cross";
  const std::size_t legit = got.size();

  rclcpp::Serialization<RadioFrame> ser_tool;
  auto payload_of = [&ser_tool](const RadioFrame & f) {
      rclcpp::SerializedMessage ser;
      ser_tool.serialize_message(&f, &ser);
      const auto & raw = ser.get_rcl_serialized_message();
      return radio::Bytes(raw.buffer, raw.buffer + raw.buffer_length);
    };
  const int attacker = ::socket(AF_INET, SOCK_DGRAM, 0);
  sockaddr_in dst{};
  dst.sin_family = AF_INET;
  dst.sin_port = htons(47322);
  ::inet_pton(AF_INET, "127.0.0.1", &dst.sin_addr);
  auto inject = [&](const radio::Bytes & d) {
      ::sendto(attacker, d.data(), d.size(), 0, reinterpret_cast<sockaddr *>(&dst), sizeof(dst));
    };
  radio::Envelope env;
  env.counter = std::numeric_limits<uint64_t>::max() / 2;  // far ahead of any real counter
  // Impersonation: claims to be A01, signed with the stolen A04 key.
  env.sender = "A01";
  env.payload = payload_of(hb);
  inject(radio::encode_signed(env, a04));
  // The revoked node speaking as itself.
  RadioFrame hb4 = hb;
  hb4.src = "A04";
  env.sender = "A04";
  env.payload = payload_of(hb4);
  inject(radio::encode_signed(env, a04));
  // A shared-key (HMAC) frame is not accepted by a signed fleet.
  radio::FleetKey group;
  group.id = 1;
  group.secret.assign(32, 0x11);
  env.sender = "A01";
  env.payload = payload_of(hb);
  inject(radio::encode(env, group));
  spin(1.0);
  ::close(attacker);
  EXPECT_EQ(got.size(), legit) << "no forged frame may reach the coordinator";
  for (auto & n : {a, b}) {
    n->deactivate();
    n->cleanup();
  }
}
