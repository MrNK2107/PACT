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

#ifndef AEROPACT_RADIO__MESH_RADIO_BRIDGE_NODE_HPP_
#define AEROPACT_RADIO__MESH_RADIO_BRIDGE_NODE_HPP_

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/radio_frame.hpp"
#include "aeropact_radio/frame_codec.hpp"
#include "diagnostic_msgs/msg/diagnostic_array.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp/serialization.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"

namespace aeropact::radio
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using RadioFrame = aeropact_interfaces::msg::RadioFrame;

/**
 * Mesh radio bridge: carries a node's RadioFrames over a real IP network (mesh radio, LTE, wired
 * test bench) with fleet authentication and replay protection. On hardware it takes the place of
 * the simulated radio medium: `radio/tx` frames are serialised (CDR), wrapped in an authenticated
 * envelope (frame_codec.hpp) and sent by UDP multicast or to a unicast peer list; datagrams from
 * the network are authenticated, checked against the per-sender replay window and published on
 * `radio/rx`. Anything that fails is dropped and counted; nothing unauthenticated reaches the
 * coordinator.
 *
 * Trust model (D-24): one fleet key (HMAC-SHA256, 256 bit) authenticates fleet membership. The
 * envelope sender must match the frame's `src`. A compromised fleet member can still impersonate
 * other members; per-node signatures are the documented upgrade path.
 */
class MeshRadioBridgeNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit MeshRadioBridgeNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("mesh_radio_bridge", options)
  {
    declare_parameter("node_id", "");
    // auth "hmac": one fleet key (key_file). auth "ed25519": this node's private key
    // (private_key_file) and the site's public-key roster (public_keys_file), D-30.
    declare_parameter("auth", "hmac");
    declare_parameter("key_file", "");
    declare_parameter("tx_key_id", -1);  // -1: the first key in the file
    declare_parameter("private_key_file", "");
    declare_parameter("public_keys_file", "");
    declare_parameter("mode", "multicast");  // multicast | unicast
    declare_parameter("multicast_group", "239.255.70.1");
    declare_parameter("port", 47000);
    declare_parameter("interface_address", "0.0.0.0");
    declare_parameter("multicast_ttl", 1);
    declare_parameter("multicast_loopback", false);  // true for several nodes on one host
    declare_parameter("peers", std::vector<std::string>{});  // unicast: "host:port"
    declare_parameter("diagnostics_period_s", 1.0);
  }

  ~MeshRadioBridgeNode() override
  {
    stop_receiver();
    close_socket();
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    node_id_ = get_parameter("node_id").as_string();
    if (node_id_.empty() || node_id_.size() > kMaxSenderId) {
      RCLCPP_ERROR(get_logger(), "node_id is required (1..64 characters)");
      return CallbackReturn::FAILURE;
    }
    const std::string auth = get_parameter("auth").as_string();
    if (auth != "hmac" && auth != "ed25519") {
      RCLCPP_ERROR(get_logger(), "auth must be hmac or ed25519");
      return CallbackReturn::FAILURE;
    }
    signed_ = auth == "ed25519";
    try {
      if (signed_) {
        signing_key_ = parse_private_key_file(read_file("private_key_file"));
        roster_ = parse_public_keys(read_file("public_keys_file"));
        const auto self = roster_.find(node_id_);
        if (self == roster_.end() || self->second != signing_key_.public_key) {
          throw std::runtime_error("this node's public key is missing from the roster or does "
                  "not match its private key");
        }
      } else {
        keys_ = parse_key_file(read_file("key_file"));
      }
    } catch (const std::exception & e) {
      RCLCPP_ERROR(get_logger(), "fleet keys: %s", e.what());
      return CallbackReturn::FAILURE;
    }
    if (!signed_) {
      const auto tx_id = get_parameter("tx_key_id").as_int();
      tx_key_ = &keys_.front();
      for (const auto & k : keys_) {
        if (tx_id >= 0 && k.id == tx_id) {
          tx_key_ = &k;
        }
      }
    }
    if (!open_socket()) {
      return CallbackReturn::FAILURE;
    }
    tx_sub_ = create_subscription<RadioFrame>(
      "radio/tx", rclcpp::QoS(200).best_effort(),
      [this](RadioFrame::ConstSharedPtr m) {on_tx(*m);});
    rx_pub_ = create_publisher<RadioFrame>("radio/rx", rclcpp::QoS(200).best_effort());
    diag_pub_ = create_publisher<diagnostic_msgs::msg::DiagnosticArray>(
      "/diagnostics", rclcpp::QoS(10));
    event_pub_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(200).reliable());
    if (signed_) {
      RCLCPP_INFO(get_logger(), "%s: mesh bridge %s port %ld, Ed25519 per-node signatures, "
        "%zu node(s) in the roster", node_id_.c_str(), get_parameter("mode").as_string().c_str(),
        get_parameter("port").as_int(), roster_.size());
    } else {
      RCLCPP_INFO(get_logger(), "%s: mesh bridge %s port %ld, %zu fleet key(s), signing with key "
        "%u", node_id_.c_str(), get_parameter("mode").as_string().c_str(),
        get_parameter("port").as_int(), keys_.size(), tx_key_->id);
    }
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    rx_pub_->on_activate();
    diag_pub_->on_activate();
    event_pub_->on_activate();
    active_ = true;
    start_receiver();
    diag_timer_ = create_wall_timer(
      std::chrono::duration<double>(get_parameter("diagnostics_period_s").as_double()),
      [this]() {publish_diagnostics();});
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    active_ = false;
    stop_receiver();
    if (diag_timer_) {
      diag_timer_->cancel();
    }
    rx_pub_->on_deactivate();
    diag_pub_->on_deactivate();
    event_pub_->on_deactivate();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    stop_receiver();
    close_socket();
    tx_sub_.reset();
    diag_timer_.reset();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    stop_receiver();
    close_socket();
    return CallbackReturn::SUCCESS;
  }

private:
  std::string read_file(const std::string & param)
  {
    const std::string path = get_parameter(param).as_string();
    std::ifstream f(path);
    if (!f) {
      throw std::runtime_error("cannot read " + param + " '" + path + "'");
    }
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
  }

  bool open_socket()
  {
    sock_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (sock_ < 0) {
      RCLCPP_ERROR(get_logger(), "socket: %s", std::strerror(errno));
      return false;
    }
    const int yes = 1;
    ::setsockopt(sock_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
    const auto port = static_cast<uint16_t>(get_parameter("port").as_int());
    const std::string mode = get_parameter("mode").as_string();
    const std::string iface = get_parameter("interface_address").as_string();
    sockaddr_in local{};
    local.sin_family = AF_INET;
    local.sin_port = htons(port);
    local.sin_addr.s_addr = htonl(INADDR_ANY);
    if (::bind(sock_, reinterpret_cast<sockaddr *>(&local), sizeof(local)) < 0) {
      RCLCPP_ERROR(get_logger(), "bind port %u: %s", port, std::strerror(errno));
      close_socket();
      return false;
    }
    destinations_.clear();
    if (mode == "multicast") {
      ip_mreq mreq{};
      if (::inet_pton(AF_INET, get_parameter("multicast_group").as_string().c_str(),
        &mreq.imr_multiaddr) != 1 || ::inet_pton(AF_INET, iface.c_str(), &mreq.imr_interface) != 1)
      {
        RCLCPP_ERROR(get_logger(), "bad multicast_group or interface_address");
        close_socket();
        return false;
      }
      if (::setsockopt(sock_, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof(mreq)) < 0) {
        RCLCPP_ERROR(get_logger(), "join multicast group: %s", std::strerror(errno));
        close_socket();
        return false;
      }
      const unsigned char ttl = static_cast<unsigned char>(get_parameter("multicast_ttl").as_int());
      const unsigned char loop = get_parameter("multicast_loopback").as_bool() ? 1 : 0;
      ::setsockopt(sock_, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl));
      ::setsockopt(sock_, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof(loop));
      ::setsockopt(sock_, IPPROTO_IP, IP_MULTICAST_IF, &mreq.imr_interface,
        sizeof(mreq.imr_interface));
      sockaddr_in dst{};
      dst.sin_family = AF_INET;
      dst.sin_port = htons(port);
      dst.sin_addr = mreq.imr_multiaddr;
      destinations_.push_back(dst);
    } else if (mode == "unicast") {
      const std::vector<std::string> peers = get_parameter("peers").as_string_array();
      for (const auto & peer : peers) {
        if (peer.empty()) {
          continue;  // launch files cannot pass an empty string array
        }
        const auto colon = peer.rfind(':');
        sockaddr_in dst{};
        dst.sin_family = AF_INET;
        if (colon == std::string::npos ||
          ::inet_pton(AF_INET, peer.substr(0, colon).c_str(), &dst.sin_addr) != 1)
        {
          RCLCPP_ERROR(get_logger(), "bad peer '%s' (expected ipv4:port)", peer.c_str());
          close_socket();
          return false;
        }
        dst.sin_port = htons(static_cast<uint16_t>(std::stoi(peer.substr(colon + 1))));
        destinations_.push_back(dst);
      }
    } else {
      RCLCPP_ERROR(get_logger(), "mode must be multicast or unicast");
      close_socket();
      return false;
    }
    return true;
  }

  void close_socket()
  {
    if (sock_ >= 0) {
      ::close(sock_);
      sock_ = -1;
    }
  }

  void on_tx(const RadioFrame & frame)
  {
    if (!active_ || sock_ < 0) {
      return;
    }
    if (frame.src != node_id_) {
      ++tx_foreign_;  // only this node's own frames leave through its bridge
      return;
    }
    rclcpp::SerializedMessage ser;
    serializer_.serialize_message(&frame, &ser);
    const auto & raw = ser.get_rcl_serialized_message();
    Envelope env;
    env.key_id = signed_ ? 0 : tx_key_->id;
    env.sender = node_id_;
    env.counter = counter_.next(static_cast<uint64_t>(
          std::chrono::duration_cast<std::chrono::nanoseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count()));
    env.payload.assign(raw.buffer, raw.buffer + raw.buffer_length);
    Bytes datagram;
    try {
      datagram = signed_ ? encode_signed(env, signing_key_) : encode(env, *tx_key_);
    } catch (const std::exception &) {
      ++tx_oversize_;
      return;
    }
    for (const auto & dst : destinations_) {
      if (::sendto(sock_, datagram.data(), datagram.size(), 0,
        reinterpret_cast<const sockaddr *>(&dst), sizeof(dst)) < 0)
      {
        ++tx_errors_;
      } else {
        ++tx_ok_;
      }
    }
  }

  void start_receiver()
  {
    stop_receiver();
    running_ = true;
    receiver_ = std::thread([this]() {receive_loop();});
  }

  void stop_receiver()
  {
    running_ = false;
    if (receiver_.joinable()) {
      receiver_.join();
    }
  }

  void receive_loop()
  {
    std::vector<uint8_t> buf(kMaxDatagram + 1);
    while (running_) {
      pollfd pfd{sock_, POLLIN, 0};
      if (::poll(&pfd, 1, 100) <= 0 || !(pfd.revents & POLLIN)) {
        continue;
      }
      const ssize_t n = ::recv(sock_, buf.data(), buf.size(), 0);
      if (n <= 0) {
        continue;
      }
      DecodeError err = DecodeError::kNone;
      auto env = signed_ ?
        decode_signed(buf.data(), static_cast<std::size_t>(n), roster_, err) :
        decode(buf.data(), static_cast<std::size_t>(n), keys_, err);
      if (!env) {
        reject(err);
        continue;
      }
      if (env->sender == node_id_) {
        continue;  // our own multicast, looped back
      }
      {
        std::lock_guard<std::mutex> lock(replay_mutex_);
        if (!replay_.accept(env->sender, env->counter)) {
          reject(DecodeError::kReplay);
          continue;
        }
      }
      RadioFrame frame;
      try {
        rclcpp::SerializedMessage ser(env->payload.size());
        auto & raw = ser.get_rcl_serialized_message();
        std::memcpy(raw.buffer, env->payload.data(), env->payload.size());
        raw.buffer_length = env->payload.size();
        serializer_.deserialize_message(&ser, &frame);
      } catch (const std::exception &) {
        reject(DecodeError::kMalformed);
        continue;
      }
      if (frame.src != env->sender) {
        reject(DecodeError::kMalformed);  // authenticated sender must be the frame's source
        continue;
      }
      ++rx_ok_;
      if (active_) {
        rx_pub_->publish(frame);
      }
    }
  }

  void reject(DecodeError e)
  {
    switch (e) {
      case DecodeError::kBadMac: ++rx_bad_mac_; break;
      case DecodeError::kUnknownKey: ++rx_unknown_key_; break;
      case DecodeError::kReplay: ++rx_replay_; break;
      default: ++rx_malformed_; break;
    }
    const auto now_s = std::chrono::duration<double>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
    std::lock_guard<std::mutex> lock(event_mutex_);
    if (active_ && now_s - last_reject_event_ > 5.0) {
      last_reject_event_ = now_s;
      aeropact_interfaces::msg::FleetEvent ev;
      ev.stamp = now();
      ev.agent = node_id_;
      ev.type = "RADIO_AUTH_REJECT";
      ev.data = std::string("{\"reason\":\"") + to_string(e) + "\",\"bad_mac\":" +
        std::to_string(rx_bad_mac_.load()) + ",\"replay\":" + std::to_string(rx_replay_.load()) +
        ",\"malformed\":" + std::to_string(rx_malformed_.load()) + "}";
      event_pub_->publish(ev);
    }
  }

  void publish_diagnostics()
  {
    diagnostic_msgs::msg::DiagnosticArray arr;
    arr.header.stamp = now();
    diagnostic_msgs::msg::DiagnosticStatus st;
    st.name = "aeropact_radio/" + node_id_;
    st.hardware_id = node_id_;
    const uint64_t rejected = rx_bad_mac_ + rx_unknown_key_ + rx_replay_ + rx_malformed_;
    st.level = rejected > last_rejected_ ? diagnostic_msgs::msg::DiagnosticStatus::WARN :
      diagnostic_msgs::msg::DiagnosticStatus::OK;
    st.message = rejected > last_rejected_ ? "rejecting unauthenticated or replayed frames" :
      "ok";
    last_rejected_ = rejected;
    auto kv = [&st](const std::string & k, uint64_t v) {
        diagnostic_msgs::msg::KeyValue p;
        p.key = k;
        p.value = std::to_string(v);
        st.values.push_back(p);
      };
    kv("tx_ok", tx_ok_);
    kv("tx_errors", tx_errors_);
    kv("tx_oversize", tx_oversize_);
    kv("tx_foreign_src", tx_foreign_);
    kv("rx_ok", rx_ok_);
    kv("rx_bad_mac", rx_bad_mac_);
    kv("rx_unknown_key", rx_unknown_key_);
    kv("rx_replay", rx_replay_);
    kv("rx_malformed", rx_malformed_);
    arr.status.push_back(st);
    diag_pub_->publish(arr);
  }

  std::string node_id_;
  std::vector<FleetKey> keys_;
  bool signed_{false};
  SigningKey signing_key_;
  std::map<std::string, Bytes> roster_;
  const FleetKey * tx_key_{nullptr};
  int sock_{-1};
  std::vector<sockaddr_in> destinations_;
  CounterSource counter_;
  ReplayWindow replay_;
  std::mutex replay_mutex_;
  std::mutex event_mutex_;
  double last_reject_event_{-1e9};
  rclcpp::Serialization<RadioFrame> serializer_;
  std::thread receiver_;
  std::atomic<bool> running_{false};
  std::atomic<bool> active_{false};
  std::atomic<uint64_t> tx_ok_{0};
  std::atomic<uint64_t> tx_errors_{0};
  std::atomic<uint64_t> tx_oversize_{0};
  std::atomic<uint64_t> tx_foreign_{0};
  std::atomic<uint64_t> rx_ok_{0};
  std::atomic<uint64_t> rx_bad_mac_{0};
  std::atomic<uint64_t> rx_unknown_key_{0};
  std::atomic<uint64_t> rx_replay_{0};
  std::atomic<uint64_t> rx_malformed_{0};
  uint64_t last_rejected_{0};

  rclcpp::Subscription<RadioFrame>::SharedPtr tx_sub_;
  rclcpp_lifecycle::LifecyclePublisher<RadioFrame>::SharedPtr rx_pub_;
  rclcpp_lifecycle::LifecyclePublisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr
    diag_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr
    event_pub_;
  rclcpp::TimerBase::SharedPtr diag_timer_;
};

}  // namespace aeropact::radio

#endif  // AEROPACT_RADIO__MESH_RADIO_BRIDGE_NODE_HPP_
