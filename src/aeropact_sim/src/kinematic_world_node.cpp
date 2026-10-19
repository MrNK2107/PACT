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

#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rosgraph_msgs/msg/clock.hpp"
#include "std_msgs/msg/bool.hpp"

namespace aeropact::sim
{

/**
 * Lightweight physics backend with the same ROS interface as the Gazebo world: it consumes
 * /<id>/cmd_vel (body frame) and /<id>/enable, publishes /<id>/odom (twist in the body frame) and
 * drives /clock. Vehicles are point masses tracking the commanded velocity with a first-order lag
 * and acceleration limits; disabled airborne vehicles fall. It can run faster than real time
 * (`time_scale`), which makes benchmark sweeps and CI scenario tests affordable. It does not model
 * collisions with buildings (the plant reports them from ground truth instead).
 */
class KinematicWorldNode : public rclcpp::Node
{
public:
  explicit KinematicWorldNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("kinematic_world", options)
  {
    declare_parameter("drone_ids", std::vector<std::string>{});
    declare_parameter("spawn", std::vector<double>{});  // x, y, z per drone
    declare_parameter("rate_hz", 50.0);
    declare_parameter("time_scale", 1.0);
    declare_parameter("tau_s", 0.35);
    declare_parameter("max_accel_mps2", 3.0);
    declare_parameter("odom_decimation", 2);
    declare_parameter("wait_for_ready", true);
    running_ = !get_parameter("wait_for_ready").as_bool();
    ready_sub_ = create_subscription<std_msgs::msg::Bool>("/system/ready",
        rclcpp::QoS(1).transient_local().reliable(), [this](std_msgs::msg::Bool::ConstSharedPtr m) {
          if (m->data && !running_) {
            RCLCPP_INFO(get_logger(), "system ready: simulation clock starts");
          }
          running_ = running_ || m->data;
        });
    const std::vector<std::string> ids = get_parameter("drone_ids").as_string_array();
    const std::vector<double> spawn = get_parameter("spawn").as_double_array();
    for (std::size_t i = 0; i < ids.size(); ++i) {
      Body b;
      if (spawn.size() >= 3 * (i + 1)) {
        b.pos = {spawn[3 * i], spawn[3 * i + 1], spawn[3 * i + 2]};
      }
      b.odom = create_publisher<nav_msgs::msg::Odometry>("/" + ids[i] + "/odom",
          rclcpp::SensorDataQoS());
      bodies_[ids[i]] = b;
      const std::string id = ids[i];
      subs_.push_back(create_subscription<geometry_msgs::msg::Twist>("/" + id + "/cmd_vel",
          rclcpp::QoS(5), [this, id](geometry_msgs::msg::Twist::ConstSharedPtr m) {
          bodies_[id].cmd = {m->linear.x, m->linear.y, m->linear.z};
          }));
      enable_subs_.push_back(create_subscription<std_msgs::msg::Bool>("/" + id + "/enable",
          rclcpp::QoS(5), [this, id](std_msgs::msg::Bool::ConstSharedPtr m) {
          bodies_[id].enabled = m->data;
          if (!m->data) {
            bodies_[id].cmd = {};
          }
          }));
    }
    clock_pub_ = create_publisher<rosgraph_msgs::msg::Clock>("/clock", rclcpp::ClockQoS());
    const double rate = get_parameter("rate_hz").as_double();
    dt_ = 1.0 / rate;
    const double scale = std::max(0.05, get_parameter("time_scale").as_double());
    timer_ = create_wall_timer(std::chrono::duration<double>(dt_ / scale), [this]() {step();});
    RCLCPP_INFO(get_logger(), "kinematic world: %zu vehicles, %.0f Hz, time scale %.1f",
      bodies_.size(), rate, scale);
  }

private:
  struct Body
  {
    geom::Vec3 pos;
    geom::Vec3 vel;
    geom::Vec3 cmd;
    bool enabled{false};
    rclcpp::Publisher<nav_msgs::msg::Odometry>::SharedPtr odom;
  };

  void step()
  {
    if (!running_) {
      // Publish the (frozen) clock so nodes have a time base, and odometry so the world is seen.
      if (++idle_ticks_ % 25 == 0) {
        rosgraph_msgs::msg::Clock c;
        c.clock = rclcpp::Time(static_cast<int64_t>(sim_time_ * 1e9));
        clock_pub_->publish(c);
        publish_odometry(c.clock);
      }
      return;
    }
    sim_time_ += dt_;
    ++ticks_;
    rosgraph_msgs::msg::Clock c;
    c.clock = rclcpp::Time(static_cast<int64_t>(sim_time_ * 1e9));
    clock_pub_->publish(c);
    const double tau = get_parameter("tau_s").as_double();
    const double amax = get_parameter("max_accel_mps2").as_double();
    const bool publish = ticks_ % static_cast<std::uint64_t>(
      std::max<int64_t>(1, get_parameter("odom_decimation").as_int())) == 0;
    for (auto & [id, b] : bodies_) {
      const bool on_ground = b.pos.z <= 0.0 + 1e-6;
      if (b.enabled) {
        geom::Vec3 acc = (b.cmd - b.vel) / tau;
        acc = geom::clamp_norm(acc, amax);
        b.vel += acc * dt_;
        if (on_ground && b.vel.z < 0.0) {
          b.vel = {0, 0, 0};
        }
      } else if (!on_ground) {
        b.vel.z -= 9.81 * dt_;
        b.vel.x *= 0.99;
        b.vel.y *= 0.99;
      } else {
        b.vel = {0, 0, 0};
      }
      b.pos += b.vel * dt_;
      if (b.pos.z < 0.0) {
        b.pos.z = 0.0;
        b.vel = {0, 0, 0};
      }
    }
    if (publish) {
      publish_odometry(c.clock);
    }
  }

  void publish_odometry(const builtin_interfaces::msg::Time & stamp)
  {
    for (auto & [id, b] : bodies_) {
      nav_msgs::msg::Odometry o;
      o.header.stamp = stamp;
      o.header.frame_id = "map";
      o.child_frame_id = id + "/base_link";
      o.pose.pose.position.x = b.pos.x;
      o.pose.pose.position.y = b.pos.y;
      o.pose.pose.position.z = b.pos.z;
      o.pose.pose.orientation.w = 1.0;
      o.twist.twist.linear.x = b.vel.x;  // yaw is held at 0, so body frame == world frame
      o.twist.twist.linear.y = b.vel.y;
      o.twist.twist.linear.z = b.vel.z;
      b.odom->publish(o);
    }
  }

  bool running_{false};
  std::uint64_t idle_ticks_{0};
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr ready_sub_;
  double dt_{0.02};
  double sim_time_{0.0};
  std::uint64_t ticks_{0};
  std::map<std::string, Body> bodies_;
  std::vector<rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr> subs_;
  std::vector<rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr> enable_subs_;
  rclcpp::Publisher<rosgraph_msgs::msg::Clock>::SharedPtr clock_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::KinematicWorldNode)
