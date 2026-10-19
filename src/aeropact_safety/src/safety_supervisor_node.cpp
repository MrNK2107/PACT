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

#include <cmath>
#include <memory>
#include <string>
#include <utility>

#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/proximity_array.hpp"
#include "aeropact_interfaces/msg/safety_status.hpp"
#include "aeropact_safety/supervisor.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "geometry_msgs/msg/twist_stamped.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "sensor_msgs/msg/battery_state.hpp"
#include "std_msgs/msg/bool.hpp"

namespace aeropact::safety
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;

/**
 * Safety supervisor component. One per vehicle, in the vehicle's namespace.
 *
 * Inputs (local only): odom (navigation solution), battery, sensing/contacts (on-board
 * detect-and-avoid), flight/cmd_vel_request and flight/arm_request from the flight manager.
 * Outputs: cmd_vel (body frame, to the flight controller), enable (motor arming), safety/status.
 * It subscribes to nothing from the mesh radio or the coordination layer (invariant I4).
 */
class SafetySupervisorNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit SafetySupervisorNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("safety_supervisor", options)
  {
    declare_parameter("drone_id", "A01");
    declare_parameter("world_file", "");
    declare_parameter("policy_file", "");
    declare_parameter("home", std::vector<double>{0.0, 0.0, 0.0});
    declare_parameter("rate_hz", 20.0);
    declare_parameter("ground_z", 0.0);
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    drone_id_ = get_parameter("drone_id").as_string();
    const auto world_file = get_parameter("world_file").as_string();
    const auto policy_file = get_parameter("policy_file").as_string();
    const auto home = get_parameter("home").as_double_array();
    ground_z_ = get_parameter("ground_z").as_double();
    if (world_file.empty() || policy_file.empty() || home.size() < 3) {
      RCLCPP_ERROR(get_logger(), "world_file, policy_file and home are required");
      return CallbackReturn::FAILURE;
    }
    try {
      supervisor_ = std::make_unique<SafetySupervisor>(
        SafetyPolicy::load(policy_file), Geofence::load(world_file), drone_id_,
        Vec3{home[0], home[1], home[2]});
    } catch (const std::exception & e) {
      RCLCPP_ERROR(get_logger(), "failed to load safety configuration: %s", e.what());
      return CallbackReturn::FAILURE;
    }

    const auto sensor_qos = rclcpp::SensorDataQoS();
    odom_sub_ = create_subscription<nav_msgs::msg::Odometry>(
      "odom", sensor_qos, [this](nav_msgs::msg::Odometry::ConstSharedPtr m) {
        input_.position = {m->pose.pose.position.x, m->pose.pose.position.y,
          m->pose.pose.position.z};
        const auto & q = m->pose.pose.orientation;
        yaw_ = std::atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z));
        // Gazebo odometry twist is in the body frame; rotate to world.
        const auto & l = m->twist.twist.linear;
        const double c = std::cos(yaw_);
        const double s = std::sin(yaw_);
        input_.velocity = {c * l.x - s * l.y, s * l.x + c * l.y, l.z};
        have_odom_ = true;
      });
    battery_sub_ = create_subscription<sensor_msgs::msg::BatteryState>(
      "battery", rclcpp::QoS(5), [this](sensor_msgs::msg::BatteryState::ConstSharedPtr m) {
        input_.soc = m->percentage;
        input_.battery_valid = true;
      });
    contacts_sub_ = create_subscription<aeropact_interfaces::msg::ProximityArray>(
      "sensing/contacts", sensor_qos,
      [this](aeropact_interfaces::msg::ProximityArray::ConstSharedPtr m) {
        input_.contacts.clear();
        for (const auto & c : m->contacts) {
          input_.contacts.push_back({c.id,
            {c.relative_position.x, c.relative_position.y, c.relative_position.z},
            {c.relative_velocity.x, c.relative_velocity.y, c.relative_velocity.z}});
        }
      });
    cmd_sub_ = create_subscription<geometry_msgs::msg::TwistStamped>(
      "flight/cmd_vel_request", rclcpp::QoS(5),
      [this](geometry_msgs::msg::TwistStamped::ConstSharedPtr m) {
        input_.mission_velocity = Vec3{m->twist.linear.x, m->twist.linear.y, m->twist.linear.z};
        input_.mission_stamp = now().seconds();
      });
    arm_sub_ = create_subscription<std_msgs::msg::Bool>(
      "flight/arm_request", rclcpp::QoS(5).transient_local(),
      [this](std_msgs::msg::Bool::ConstSharedPtr m) {input_.arm_request = m->data;});

    cmd_pub_ = create_publisher<geometry_msgs::msg::Twist>("cmd_vel", rclcpp::QoS(5));
    enable_pub_ = create_publisher<std_msgs::msg::Bool>("enable", rclcpp::QoS(5));
    status_pub_ = create_publisher<aeropact_interfaces::msg::SafetyStatus>(
      "safety/status", rclcpp::QoS(10));
    event_pub_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(200).reliable());
    RCLCPP_INFO(get_logger(), "safety supervisor configured for %s", drone_id_.c_str());
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    cmd_pub_->on_activate();
    enable_pub_->on_activate();
    status_pub_->on_activate();
    event_pub_->on_activate();
    const double rate = get_parameter("rate_hz").as_double();
    // Timer on the node clock: follows simulation time when use_sim_time is set.
    timer_ = rclcpp::create_timer(
      this, get_clock(), rclcpp::Duration::from_seconds(1.0 / rate), [this]() {step();});
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    if (timer_) {
      timer_->cancel();
    }
    cmd_pub_->on_deactivate();
    enable_pub_->on_deactivate();
    status_pub_->on_deactivate();
    event_pub_->on_deactivate();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    supervisor_.reset();
    odom_sub_.reset();
    battery_sub_.reset();
    contacts_sub_.reset();
    cmd_sub_.reset();
    arm_sub_.reset();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  void step()
  {
    if (!supervisor_ || !have_odom_) {
      return;
    }
    input_.now = now().seconds();
    input_.ground_z = ground_z_;
    const SafetyOutput out = supervisor_->step(input_);

    // World -> body (yaw only) for the multicopter velocity controller.
    const double c = std::cos(yaw_);
    const double s = std::sin(yaw_);
    geometry_msgs::msg::Twist cmd;
    cmd.linear.x = c * out.velocity.x + s * out.velocity.y;
    cmd.linear.y = -s * out.velocity.x + c * out.velocity.y;
    cmd.linear.z = out.velocity.z;
    cmd.angular.z = -0.5 * yaw_;  // hold heading north-east aligned to keep the frames simple
    if (out.armed) {
      cmd_pub_->publish(cmd);
    }
    if (out.armed != last_armed_ || ++enable_counter_ % 20 == 0) {
      std_msgs::msg::Bool en;
      en.data = out.armed;
      enable_pub_->publish(en);
      if (!out.armed && last_armed_) {
        cmd_pub_->publish(geometry_msgs::msg::Twist());
      }
    }

    aeropact_interfaces::msg::SafetyStatus st;
    st.header.stamp = now();
    st.header.frame_id = "map";
    st.drone_id = drone_id_;
    st.action = static_cast<uint8_t>(out.action);
    st.reason = out.reason;
    st.veto_active = out.veto;
    st.armed = out.armed;
    st.soc = static_cast<float>(input_.soc);
    st.min_separation_m = static_cast<float>(out.min_separation);
    st.geofence_ok = out.geofence_ok;
    st.command_fresh = out.command_fresh;
    status_pub_->publish(st);

    // REQ-SAF-004: every change of intervention is logged.
    if (out.action != last_action_ || out.armed != last_armed_) {
      aeropact_interfaces::msg::FleetEvent ev;
      ev.stamp = now();
      ev.agent = drone_id_;
      ev.type = out.armed != last_armed_ ? (out.armed ? "ARMED" : "DISARMED") : "SAFETY_ACTION";
      ev.data = std::string("{\"action\":\"") + to_string(out.action) + "\",\"reason\":\"" +
        out.reason + "\",\"veto\":" + (out.veto ? "true" : "false") + ",\"x\":" +
        std::to_string(input_.position.x) + ",\"y\":" + std::to_string(input_.position.y) +
        ",\"z\":" + std::to_string(input_.position.z) + "}";
      event_pub_->publish(ev);
    }
    last_action_ = out.action;
    last_armed_ = out.armed;
  }

  std::string drone_id_;
  double ground_z_{0.0};
  std::unique_ptr<SafetySupervisor> supervisor_;
  SafetyInput input_;
  double yaw_{0.0};
  bool have_odom_{false};
  bool last_armed_{false};
  Action last_action_{Action::kDisarmed};
  unsigned enable_counter_{0};

  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
  rclcpp::Subscription<sensor_msgs::msg::BatteryState>::SharedPtr battery_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::ProximityArray>::SharedPtr contacts_sub_;
  rclcpp::Subscription<geometry_msgs::msg::TwistStamped>::SharedPtr cmd_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr arm_sub_;
  rclcpp_lifecycle::LifecyclePublisher<geometry_msgs::msg::Twist>::SharedPtr cmd_pub_;
  rclcpp_lifecycle::LifecyclePublisher<std_msgs::msg::Bool>::SharedPtr enable_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::SafetyStatus>::SharedPtr
    status_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr
    event_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::safety

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::safety::SafetySupervisorNode)
