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

#include <map>
#include <memory>
#include <queue>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_core/json.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/radio_frame.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_sim/channel_model.hpp"
#include "aeropact_sim/yaml_json.hpp"
#include "diagnostic_msgs/msg/diagnostic_array.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp/serialized_message.hpp"
#include "rclcpp_components/register_node_macro.hpp"

namespace aeropact::sim
{

using RadioFrame = aeropact_interfaces::msg::RadioFrame;

/**
 * The simulated mesh radio: the physical medium between every drone and depot. It forwards
 * frames in serialized form (no deserialisation cost) from each endpoint's radio/tx to every other
 * endpoint's radio/rx subject to the channel model (range, loss, latency, partitions, asymmetric
 * links). Positions are ground truth from the physics backend. It is part of the simulated world,
 * not of the fleet: nothing coordinates through it except by sending frames.
 */
class RadioMediumNode : public rclcpp::Node
{
public:
  explicit RadioMediumNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("radio_medium", options)
  {
    declare_parameter("drone_ids", std::vector<std::string>{});
    declare_parameter("depot_ids", std::vector<std::string>{});
    declare_parameter("world_file", "");
    declare_parameter("range_m", 1500.0);
    declare_parameter("base_loss", 0.02);
    declare_parameter("latency_min_s", 0.05);
    declare_parameter("latency_max_s", 0.25);
    declare_parameter("seed", 1);
    declare_parameter("stats_period_s", 10.0);
    declare_parameter("max_queue", 50000);

    ChannelConfig cfg;
    cfg.range_m = get_parameter("range_m").as_double();
    cfg.base_loss = get_parameter("base_loss").as_double();
    cfg.latency_min_s = get_parameter("latency_min_s").as_double();
    cfg.latency_max_s = get_parameter("latency_max_s").as_double();
    channel_ = ChannelModel(cfg, static_cast<std::uint64_t>(get_parameter("seed").as_int()));

    const auto qos = rclcpp::QoS(200).best_effort();
    const std::vector<std::string> drones = get_parameter("drone_ids").as_string_array();
    const std::vector<std::string> depots = get_parameter("depot_ids").as_string_array();
    std::unique_ptr<core::WorldModel> world;
    const std::string world_file = get_parameter("world_file").as_string();
    if (!world_file.empty()) {
      world = std::make_unique<core::WorldModel>(core::WorldModel::load(world_file));
    }
    for (const auto & d : drones) {
      add_endpoint(d, "/" + d, false, {});
    }
    for (const auto & d : depots) {
      geom::Vec3 p;
      if (world) {
        if (const core::Depot * dep = world->depot(d)) {
          p = dep->position;
          p.z += 15.0;  // antenna on the depot roof
        }
      }
      add_endpoint(d, "/depots/" + d, true, p);
    }
    for (std::size_t i = 0; i < endpoints_.size(); ++i) {
      auto & e = endpoints_[i];
      e.pub = create_publisher<RadioFrame>(e.prefix + "/radio/rx", qos);
      e.sub = create_subscription<RadioFrame>(e.prefix + "/radio/tx", qos,
          [this, i](std::shared_ptr<const rclcpp::SerializedMessage> msg) {on_frame(i, msg);});
      if (!e.depot) {
        e.odom = create_subscription<nav_msgs::msg::Odometry>(
          "/" + e.id + "/odom", rclcpp::SensorDataQoS(),
          [this, i](nav_msgs::msg::Odometry::ConstSharedPtr m) {
            endpoints_[i].pos = {m->pose.pose.position.x, m->pose.pose.position.y,
              m->pose.pose.position.z};
            endpoints_[i].have_pos = true;
          });
      }
    }
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    diag_ = create_publisher<diagnostic_msgs::msg::DiagnosticArray>("/diagnostics", 10);
    fault_srv_ = create_service<aeropact_interfaces::srv::InjectFault>("/sim/radio/inject_fault",
        [this](const std::shared_ptr<aeropact_interfaces::srv::InjectFault::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::InjectFault::Response> rs) {on_fault(*rq, *rs);});
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(0.01),
        [this]() {flush();});
    RCLCPP_INFO(get_logger(), "radio medium: %zu endpoints, range %.0f m, loss %.2f",
      endpoints_.size(), cfg.range_m, cfg.base_loss);
  }

private:
  struct Stats
  {
    std::uint64_t tx_frames{0};
    std::uint64_t tx_bytes{0};
    std::uint64_t rx_frames{0};
    std::uint64_t rx_bytes{0};
    std::map<std::string, std::uint64_t> drops;
  };

  struct Endpoint
  {
    std::string id;
    std::string prefix;
    bool depot{false};
    geom::Vec3 pos;
    bool have_pos{false};
    Stats stats;
    rclcpp::Publisher<RadioFrame>::SharedPtr pub;
    rclcpp::Subscription<RadioFrame>::SharedPtr sub;
    rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom;
  };

  struct Pending
  {
    double due;
    std::uint64_t seq;
    std::size_t dst;
    std::shared_ptr<const rclcpp::SerializedMessage> msg;
    bool operator>(const Pending & o) const
    {
      return due != o.due ? due > o.due : seq > o.seq;
    }
  };

  void add_endpoint(
    const std::string & id, const std::string & prefix, bool depot,
    const geom::Vec3 & pos)
  {
    Endpoint e;
    e.id = id;
    e.prefix = prefix;
    e.depot = depot;
    e.pos = pos;
    e.have_pos = depot;
    endpoints_.push_back(std::move(e));
  }

  void on_frame(std::size_t src, std::shared_ptr<const rclcpp::SerializedMessage> msg)
  {
    const double t = now().seconds();
    channel_.expire(t);
    Endpoint & s = endpoints_[src];
    const std::size_t bytes = msg->size();
    s.stats.tx_frames += 1;
    s.stats.tx_bytes += bytes;
    if (!s.have_pos) {
      return;
    }
    const auto max_queue = static_cast<std::size_t>(get_parameter("max_queue").as_int());
    for (std::size_t d = 0; d < endpoints_.size(); ++d) {
      if (d == src) {
        continue;
      }
      Endpoint & r = endpoints_[d];
      if (!r.have_pos) {
        continue;
      }
      const LinkDecision dec = channel_.decide(s.id, s.pos, r.id, r.pos, t);
      if (!dec.delivered) {
        s.stats.drops[dec.drop_reason] += 1;
        continue;
      }
      if (queue_.size() >= max_queue) {
        s.stats.drops["queue_full"] += 1;
        continue;
      }
      queue_.push({t + dec.latency_s, ++seq_, d, msg});
    }
  }

  void flush()
  {
    const double t = now().seconds();
    while (!queue_.empty() && queue_.top().due <= t) {
      const Pending p = queue_.top();
      queue_.pop();
      Endpoint & r = endpoints_[p.dst];
      r.stats.rx_frames += 1;
      r.stats.rx_bytes += p.msg->size();
      r.pub->publish(*p.msg);
    }
    if (t - last_stats_ >= get_parameter("stats_period_s").as_double()) {
      last_stats_ = t;
      publish_stats();
    }
  }

  void publish_stats()
  {
    diagnostic_msgs::msg::DiagnosticArray arr;
    arr.header.stamp = now();
    std::string per_node = "{";
    bool first = true;
    for (const auto & e : endpoints_) {
      core::Json j;
      j.add("tx", e.stats.tx_frames).add("tx_bytes", e.stats.tx_bytes)
      .add("rx", e.stats.rx_frames).add("rx_bytes", e.stats.rx_bytes).add("depot", e.depot);
      std::uint64_t dropped = 0;
      for (const auto & [reason, n] : e.stats.drops) {
        j.add("drop_" + reason, n);
        dropped += n;
      }
      per_node += (first ? "\"" : ",\"") + e.id + "\":" + j.str();
      first = false;
      diagnostic_msgs::msg::DiagnosticStatus st;
      st.name = "radio/" + e.id;
      st.hardware_id = e.id;
      st.level = diagnostic_msgs::msg::DiagnosticStatus::OK;
      st.message = "tx " + std::to_string(e.stats.tx_frames) + " rx " +
        std::to_string(e.stats.rx_frames) + " dropped " + std::to_string(dropped);
      arr.status.push_back(st);
    }
    per_node += "}";
    diag_->publish(arr);
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = "radio_medium";
    ev.type = "RADIO_STATS";
    ev.data = core::Json().add("queue", static_cast<uint64_t>(queue_.size()))
      .raw("nodes", per_node).str();
    events_->publish(ev);
  }

  void on_fault(
    const aeropact_interfaces::srv::InjectFault::Request & rq,
    aeropact_interfaces::srv::InjectFault::Response & rs)
  {
    const YAML::Node a = parse_args(rq.args);
    const double until = a["until"] ? a["until"].as<double>() : -1.0;
    rs.success = true;
    try {
      if (rq.type == "partition") {
        std::vector<std::set<std::string>> groups;
        for (const auto & g : a["groups"]) {
          std::set<std::string> s;
          for (const auto & n : g) {
            s.insert(n.as<std::string>());
          }
          groups.push_back(s);
        }
        channel_.partition(groups, until);
      } else if (rq.type == "heal") {
        channel_.heal();
      } else if (rq.type == "link_loss") {
        channel_.set_node_loss(a["id"].as<std::string>(), a["loss"] ? a["loss"].as<double>() : 1.0,
          until);
      } else if (rq.type == "loss") {
        channel_.set_global_loss(a["value"].as<double>(), until);
      } else if (rq.type == "asymmetric_link") {
        channel_.block_direction(a["from"].as<std::string>(), a["to"].as<std::string>(), until);
      } else {
        rs.success = false;
        rs.message = "unknown radio fault " + rq.type;
      }
    } catch (const YAML::Exception & e) {
      rs.success = false;
      rs.message = std::string("bad arguments: ") + e.what();
    }
    RCLCPP_INFO(get_logger(), "radio fault %s %s: %s", rq.type.c_str(), rq.args.c_str(),
      rs.success ? "applied" : rs.message.c_str());
  }

  ChannelModel channel_;
  std::vector<Endpoint> endpoints_;
  std::priority_queue<Pending, std::vector<Pending>, std::greater<Pending>> queue_;
  std::uint64_t seq_{0};
  double last_stats_{0.0};
  rclcpp::Publisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::Publisher<diagnostic_msgs::msg::DiagnosticArray>::SharedPtr diag_;
  rclcpp::Service<aeropact_interfaces::srv::InjectFault>::SharedPtr fault_srv_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::RadioMediumNode)
