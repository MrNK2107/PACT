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
#include <cmath>
#include <memory>
#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"
#include "aeropact_interfaces/action/fly_route.hpp"
#include "aeropact_interfaces/msg/autopilot_status.hpp"
#include "aeropact_interfaces/msg/safety_status.hpp"
#include "geometry_msgs/msg/twist_stamped.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_action/rclcpp_action.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "std_msgs/msg/bool.hpp"

namespace aeropact::agent
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using FlyRoute = aeropact_interfaces::action::FlyRoute;
using ServerGoalHandle = rclcpp_action::ServerGoalHandle<FlyRoute>;
using SafetyStatus = aeropact_interfaces::msg::SafetyStatus;
using geom::Vec3;

/**
 * Flight manager: the mission layer's FlightAdapter (PRD 9.2) on top of a velocity-controlled
 * multirotor. Serves `flight/fly_route` (one goal at a time; a new goal preempts the old one) and
 * turns waypoints into world-frame velocity setpoints for the safety supervisor:
 *   - look-ahead tracking along the current segment,
 *   - speed limited by the stopping distance to the final point and by the turn angle at the
 *     next corner (a multirotor at 9 m/s with 2 m/s^2 cannot turn on the spot),
 *   - separate climb and descent rate limits, slow final descent and touchdown detection.
 * Between goals it holds position while airborne, so the safety watchdog stays fed.
 */
class FlightManagerNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit FlightManagerNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("flight_manager", options)
  {
    declare_parameter("rate_hz", 20.0);
    declare_parameter("max_accel_mps2", 1.8);
    declare_parameter("max_climb_mps", 2.5);
    declare_parameter("max_descent_mps", 2.5);
    declare_parameter("final_descent_mps", 0.5);
    declare_parameter("lookahead_m", 6.0);
    declare_parameter("waypoint_radius_m", 4.0);
    declare_parameter("position_gain", 0.6);
    declare_parameter("timeout_margin_s", 90.0);
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    odom_sub_ = create_subscription<nav_msgs::msg::Odometry>("odom", rclcpp::SensorDataQoS(),
        [this](nav_msgs::msg::Odometry::ConstSharedPtr m) {
          pos_ = {m->pose.pose.position.x, m->pose.pose.position.y, m->pose.pose.position.z};
          const auto & q = m->pose.pose.orientation;
          const double yaw = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
          1.0 - 2.0 * (q.y * q.y + q.z * q.z));
          const auto & l = m->twist.twist.linear;
          vel_ = {std::cos(yaw) * l.x - std::sin(yaw) * l.y,
            std::sin(yaw) * l.x + std::cos(yaw) * l.y, l.z};
          if (!have_odom_) {
            hold_ = pos_;
          }
          have_odom_ = true;
        });
    safety_sub_ = create_subscription<SafetyStatus>("safety/status", rclcpp::QoS(10),
        [this](SafetyStatus::ConstSharedPtr m) {safety_ = *m;});
    autopilot_sub_ = create_subscription<aeropact_interfaces::msg::AutopilotStatus>(
      "autopilot/status", rclcpp::QoS(5),
      [this](aeropact_interfaces::msg::AutopilotStatus::ConstSharedPtr m) {
        autopilot_landed_ = m->landed;
        autopilot_stamp_ = now().seconds();
      });
    cmd_pub_ = create_publisher<geometry_msgs::msg::TwistStamped>(
      "flight/cmd_vel_request", rclcpp::QoS(5));
    arm_pub_ = create_publisher<std_msgs::msg::Bool>(
      "flight/arm_request", rclcpp::QoS(1).transient_local());
    server_ = rclcpp_action::create_server<FlyRoute>(
      this, "flight/fly_route",
      [this](const rclcpp_action::GoalUUID &, std::shared_ptr<const FlyRoute::Goal> g) {
        if (!active_ || g->waypoints.empty() || g->cruise_speed <= 0.0f) {
          return rclcpp_action::GoalResponse::REJECT;
        }
        return rclcpp_action::GoalResponse::ACCEPT_AND_EXECUTE;
      },
      [](const std::shared_ptr<ServerGoalHandle>) {return rclcpp_action::CancelResponse::ACCEPT;},
      [this](const std::shared_ptr<ServerGoalHandle> h) {accept(h);});
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    cmd_pub_->on_activate();
    arm_pub_->on_activate();
    active_ = true;
    timer_ = rclcpp::create_timer(this, get_clock(),
        rclcpp::Duration::from_seconds(1.0 / get_parameter("rate_hz").as_double()),
        [this]() {step();});
    set_arm(false);
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    active_ = false;
    if (timer_) {
      timer_->cancel();
    }
    finish(false, FlyRoute::Result::CODE_CANCELED);
    cmd_pub_->on_deactivate();
    arm_pub_->on_deactivate();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    server_.reset();
    odom_sub_.reset();
    safety_sub_.reset();
    autopilot_sub_.reset();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  void accept(const std::shared_ptr<ServerGoalHandle> h)
  {
    finish(false, FlyRoute::Result::CODE_CANCELED);  // preempt
    goal_ = h;
    wps_.clear();
    for (const auto & p : h->get_goal()->waypoints) {
      wps_.push_back({p.x, p.y, p.z});
    }
    idx_ = 0;
    speed_ = h->get_goal()->cruise_speed;
    land_ = h->get_goal()->terminal == FlyRoute::Goal::TERMINAL_LAND;
    accept_r_ = std::max(0.3f, h->get_goal()->acceptance_radius);
    double len = geom::dist(pos_, wps_.front());
    for (std::size_t i = 1; i < wps_.size(); ++i) {
      len += geom::dist(wps_[i - 1], wps_[i]);
    }
    deadline_ = now().seconds() + 2.0 * len / std::max(1.0, speed_) +
      get_parameter("timeout_margin_s").as_double();
    touchdown_since_ = -1.0;
    set_arm(true);
  }

  void finish(bool success, uint8_t code)
  {
    if (!goal_) {
      return;
    }
    auto result = std::make_shared<FlyRoute::Result>();
    result->success = success;
    result->code = code;
    result->final_error_m = wps_.empty() ? 0.0f : static_cast<float>(geom::dist(pos_, wps_.back()));
    if (goal_->is_canceling()) {
      goal_->canceled(result);
    } else if (goal_->is_active()) {
      if (success) {
        goal_->succeed(result);
      } else {
        goal_->abort(result);
      }
    }
    // Hold where the route ended when it was flown to completion; otherwise hold where we are.
    // Holding at an abandoned goal's end point would keep flying a cancelled route.
    hold_ = success && !wps_.empty() ? wps_.back() : pos_;
    goal_.reset();
  }

  void set_arm(bool armed)
  {
    if (arm_request_ == armed && arm_sent_) {
      return;
    }
    arm_request_ = armed;
    arm_sent_ = true;
    std_msgs::msg::Bool b;
    b.data = armed;
    arm_pub_->publish(b);
  }

  void publish(const Vec3 & v)
  {
    geometry_msgs::msg::TwistStamped t;
    t.header.stamp = now();
    t.header.frame_id = "map";
    t.twist.linear.x = v.x;
    t.twist.linear.y = v.y;
    t.twist.linear.z = v.z;
    cmd_pub_->publish(t);
  }

  Vec3 hold_velocity(const Vec3 & target) const
  {
    const double k = get_parameter("position_gain").as_double();
    Vec3 v = (target - pos_) * k;
    v = geom::clamp_xy(v, 3.0);
    v.z = std::clamp(v.z, -get_parameter("max_descent_mps").as_double(),
        get_parameter("max_climb_mps").as_double());
    return v;
  }

  void step()
  {
    if (!have_odom_ || !active_) {
      return;
    }
    const double t = now().seconds();
    const uint8_t a = safety_.action;
    const bool contingency = a == SafetyStatus::ACTION_RTL ||
      a == SafetyStatus::ACTION_LAND_NEAREST || a == SafetyStatus::ACTION_LAND_NOW ||
      a == SafetyStatus::ACTION_AUTOPILOT;
    if (contingency) {
      // The supervisor flies the vehicle now; withdraw the arm request so it stays down after
      // the contingency landing until the mission layer sends a new route.
      finish(false, FlyRoute::Result::CODE_SAFETY_ABORT);
      set_arm(false);
      return;
    }
    if (!goal_) {
      if (arm_request_) {
        publish(hold_velocity(hold_));
      }
      return;
    }
    if (goal_->is_canceling()) {
      finish(false, FlyRoute::Result::CODE_CANCELED);
      return;
    }
    if (t > deadline_) {
      finish(false, FlyRoute::Result::CODE_TIMEOUT);
      return;
    }
    if (!safety_.armed) {
      publish({0, 0, 0});  // wait for the supervisor to arm
      return;
    }

    const double max_climb = get_parameter("max_climb_mps").as_double();
    const double max_descent = get_parameter("max_descent_mps").as_double();
    const double accel = get_parameter("max_accel_mps2").as_double();
    const double wp_radius = get_parameter("waypoint_radius_m").as_double();
    const std::size_t last = wps_.size() - 1;

    // Advance through intermediate waypoints.
    while (idx_ < last && geom::dist(pos_, wps_[idx_]) < wp_radius) {
      ++idx_;
    }
    const Vec3 & target = wps_[idx_];

    // Final approach and termination.
    if (idx_ == last) {
      const double dxy = geom::dist_xy(pos_, target);
      const double dz = target.z - pos_.z;
      if (!land_ && dxy < accept_r_ && std::abs(dz) < std::max(1.0, accept_r_ * 0.75) &&
        geom::norm(vel_) < 1.0)
      {
        finish(true, FlyRoute::Result::CODE_REACHED);
        publish(hold_velocity(hold_));
        return;
      }
      if (land_ && dxy < 1.5) {
        Vec3 v = (target - pos_) * 0.6;
        v.z = pos_.z - target.z >
          6.0 ? -max_descent : -get_parameter("final_descent_mps").as_double();
        publish(geom::clamp_xy(v, 1.0));
        // With an autopilot, its land detector decides touchdown: the height estimate over the
        // pad carries baro / GNSS error of a few decimetres.
        const bool autopilot_landed = autopilot_landed_ && t - autopilot_stamp_ < 1.0;
        const bool settled = std::abs(vel_.z) < 0.2 &&
          (pos_.z - target.z < 0.35 || autopilot_landed);
        if (settled) {
          if (touchdown_since_ < 0.0) {
            touchdown_since_ = t;
          }
          if (t - touchdown_since_ > 1.0) {
            set_arm(false);
            finish(true, FlyRoute::Result::CODE_REACHED);
          }
        } else {
          touchdown_since_ = -1.0;
        }
        return;
      }
    }

    // Look-ahead point along the current segment.
    const Vec3 from = idx_ == 0 ? pos_ : wps_[idx_ - 1];
    Vec3 aim = target;
    const Vec3 seg = target - from;
    const double seg_len = geom::norm(seg);
    if (seg_len > 1e-3) {
      const double s = std::clamp(geom::dot(pos_ - from, seg) / (seg_len * seg_len), 0.0, 1.0);
      const double look = get_parameter("lookahead_m").as_double() / seg_len;
      const double sa = std::min(1.0, s + look);
      aim = from + seg * sa;
    }

    // Speed limits: stopping distance to the end of the route and turn angle at the corner.
    double remaining = geom::dist(pos_, target);
    for (std::size_t i = idx_ + 1; i < wps_.size(); ++i) {
      remaining += geom::dist(wps_[i - 1], wps_[i]);
    }
    double v_max = std::min<double>(speed_,
        std::sqrt(2.0 * accel * std::max(0.0, remaining)) + 0.3);
    if (idx_ < last) {
      const Vec3 in = target - from;
      const Vec3 out = wps_[idx_ + 1] - target;
      const double ni = geom::norm(in);
      const double no = geom::norm(out);
      if (ni > 1e-3 && no > 1e-3) {
        const double cosang = std::clamp(geom::dot(in, out) / (ni * no), -1.0, 1.0);
        const double turn = std::acos(cosang);
        const double v_corner = std::max(2.0, speed_ * (1.0 - turn / M_PI));
        const double d_corner = geom::dist(pos_, target);
        v_max = std::min(v_max, std::sqrt(v_corner * v_corner + 2.0 * accel * d_corner));
      }
    }
    Vec3 dir = aim - pos_;
    const double horizontal = geom::norm_xy(dir);
    Vec3 v{0, 0, 0};
    if (horizontal > 1e-3) {
      const double hs = std::min(v_max, horizontal * 1.2);
      v.x = dir.x / horizontal * hs;
      v.y = dir.y / horizontal * hs;
    }
    // Vertical: rate-limited; when far below the layer (take-off) climb before moving sideways.
    v.z = std::clamp((aim.z - pos_.z) * 0.8, -max_descent, max_climb);
    if (target.z - pos_.z > 6.0 && idx_ == 0 && geom::dist_xy(pos_, target) < 2.0) {
      v.x *= 0.2;
      v.y *= 0.2;
    }
    publish(v);

    if (t - last_feedback_ > 0.5) {
      last_feedback_ = t;
      auto fb = std::make_shared<FlyRoute::Feedback>();
      fb->waypoint_index = static_cast<uint32_t>(idx_);
      fb->distance_remaining_m = static_cast<float>(remaining);
      fb->eta_s = static_cast<float>(remaining / std::max(1.0, speed_));
      goal_->publish_feedback(fb);
    }
  }

  bool active_{false};
  bool have_odom_{false};
  Vec3 pos_;
  Vec3 vel_;
  Vec3 hold_;
  SafetyStatus safety_;
  bool autopilot_landed_{false};
  double autopilot_stamp_{-1e9};
  std::shared_ptr<ServerGoalHandle> goal_;
  std::vector<Vec3> wps_;
  std::size_t idx_{0};
  double speed_{8.0};
  bool land_{false};
  float accept_r_{2.0f};
  double deadline_{0.0};
  double touchdown_since_{-1.0};
  double last_feedback_{0.0};
  bool arm_request_{false};
  bool arm_sent_{false};

  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
  rclcpp::Subscription<SafetyStatus>::SharedPtr safety_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::AutopilotStatus>::SharedPtr autopilot_sub_;
  rclcpp_lifecycle::LifecyclePublisher<geometry_msgs::msg::TwistStamped>::SharedPtr cmd_pub_;
  rclcpp_lifecycle::LifecyclePublisher<std_msgs::msg::Bool>::SharedPtr arm_pub_;
  rclcpp_action::Server<FlyRoute>::SharedPtr server_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::agent

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::agent::FlightManagerNode)
