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

#include <chrono>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "lifecycle_msgs/msg/state.hpp"
#include "lifecycle_msgs/msg/transition.hpp"
#include "lifecycle_msgs/srv/change_state.hpp"
#include "lifecycle_msgs/srv/get_state.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "std_msgs/msg/bool.hpp"
#include "std_srvs/srv/trigger.hpp"

namespace aeropact::agent
{

using ChangeState = lifecycle_msgs::srv::ChangeState;
using Transition = lifecycle_msgs::msg::Transition;

/**
 * Brings a list of lifecycle nodes to ACTIVE in order (configure, then activate), without
 * blocking the executor, and reports each transition as a fleet event. Nodes that fail to
 * configure are retried. Exposes ~/startup and ~/shutdown triggers.
 */
class LifecycleManagerNode : public rclcpp::Node
{
public:
  explicit LifecycleManagerNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("lifecycle_manager", options)
  {
    declare_parameter("node_names", std::vector<std::string>{});
    declare_parameter("autostart", true);
    declare_parameter("retry_period_s", 2.0);
    declare_parameter("on_ready_command", "");
    names_ = get_parameter("node_names").as_string_array();
    for (const auto & n : names_) {
      clients_[n] = create_client<ChangeState>(n + "/change_state");
      stage_[n] = Stage::kUnconfigured;
    }
    ready_pub_ = create_publisher<std_msgs::msg::Bool>(
      "/system/ready", rclcpp::QoS(1).transient_local().reliable());
    std_msgs::msg::Bool not_ready;
    not_ready.data = false;
    ready_pub_->publish(not_ready);
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(200).reliable());
    startup_ = create_service<std_srvs::srv::Trigger>("~/startup",
        [this](const std::shared_ptr<std_srvs::srv::Trigger::Request>,
        std::shared_ptr<std_srvs::srv::Trigger::Response> res) {
          running_ = true;
          res->success = true;
        });
    shutdown_ = create_service<std_srvs::srv::Trigger>("~/shutdown",
        [this](const std::shared_ptr<std_srvs::srv::Trigger::Request>,
        std::shared_ptr<std_srvs::srv::Trigger::Response> res) {
          running_ = false;
          for (const auto & n : names_) {
            transition(n, Transition::TRANSITION_DEACTIVATE, Stage::kUnconfigured);
          }
          res->success = true;
        });
    running_ = get_parameter("autostart").as_bool();
    // Wall timer on purpose: bring-up must work before simulation time starts flowing.
    timer_ = create_wall_timer(std::chrono::milliseconds(200), [this]() {step();});
  }

private:
  enum class Stage { kUnconfigured, kConfiguring, kInactive, kActivating, kActive, kFailed };

  void step()
  {
    if (!running_) {
      return;
    }
    const double t = now().seconds();
    for (const auto & n : names_) {
      Stage & s = stage_[n];
      if (s == Stage::kConfiguring || s == Stage::kActivating || s == Stage::kActive) {
        if (s != Stage::kActive) {
          return;  // strictly in order
        }
        continue;
      }
      if (!clients_[n]->service_is_ready()) {
        RCLCPP_INFO_THROTTLE(get_logger(), *get_clock(), 5000, "waiting for %s", n.c_str());
        return;
      }
      if (s == Stage::kFailed && t - failed_at_[n] < get_parameter("retry_period_s").as_double()) {
        return;
      }
      if (s == Stage::kUnconfigured || s == Stage::kFailed) {
        transition(n, Transition::TRANSITION_CONFIGURE, Stage::kInactive);
        s = Stage::kConfiguring;
      } else if (s == Stage::kInactive) {
        transition(n, Transition::TRANSITION_ACTIVATE, Stage::kActive);
        s = Stage::kActivating;
      }
      return;
    }
    if (!announced_) {
      announced_ = true;
      RCLCPP_INFO(get_logger(), "all %zu managed nodes active", names_.size());
      // Simulation time is held until the whole system is up (see kinematic_world and the
      // Gazebo start-paused option), so scripted faults and orders meet a live system.
      std_msgs::msg::Bool ready;
      ready.data = true;
      ready_pub_->publish(ready);
      const std::string cmd = get_parameter("on_ready_command").as_string();
      if (!cmd.empty()) {
        const int rc = std::system(cmd.c_str());
        RCLCPP_INFO(get_logger(), "on-ready command exited with %d", rc);
      }
    }
  }

  void transition(const std::string & node, uint8_t id, Stage on_success)
  {
    auto req = std::make_shared<ChangeState::Request>();
    req->transition.id = id;
    clients_[node]->async_send_request(req,
      [this, node, id, on_success](rclcpp::Client<ChangeState>::SharedFuture f) {
        const bool ok = f.get()->success;
        stage_[node] = ok ? on_success : Stage::kFailed;
        if (!ok) {
          failed_at_[node] = now().seconds();
          RCLCPP_WARN(get_logger(), "transition %u failed for %s", id, node.c_str());
        }
        aeropact_interfaces::msg::FleetEvent ev;
        ev.stamp = now();
        ev.agent = "lifecycle_manager";
        ev.type = "LIFECYCLE";
        ev.data = "{\"node\":\"" + node + "\",\"transition\":" + std::to_string(id) +
        ",\"ok\":" + (ok ? "true" : "false") + "}";
        events_->publish(ev);
      });
  }

  std::vector<std::string> names_;
  std::map<std::string, rclcpp::Client<ChangeState>::SharedPtr> clients_;
  std::map<std::string, Stage> stage_;
  std::map<std::string, double> failed_at_;
  bool running_{true};
  bool announced_{false};
  rclcpp::Publisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr ready_pub_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr startup_;
  rclcpp::Service<std_srvs::srv::Trigger>::SharedPtr shutdown_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::agent

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::agent::LifecycleManagerNode)
