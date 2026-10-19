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
#include <map>
#include <memory>
#include <random>
#include <string>
#include <vector>

#include "aeropact_geometry/geometry.hpp"
#include "aeropact_interfaces/msg/proximity_array.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"

namespace aeropact::sim
{

/**
 * Simulated on-board detect-and-avoid sensing (transponder / ranging): every drone gets the
 * relative position and velocity of aircraft within range, with noise. Independent of the mesh
 * radio, so the safety reflex works with the network down (invariant I4).
 */
class ProximitySensorNode : public rclcpp::Node
{
public:
  explicit ProximitySensorNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("proximity_sensor", options)
  {
    declare_parameter("drone_ids", std::vector<std::string>{});
    declare_parameter("range_m", 70.0);
    declare_parameter("rate_hz", 10.0);
    declare_parameter("position_noise_m", 0.3);
    declare_parameter("velocity_noise_mps", 0.2);
    declare_parameter("seed", 3);
    rng_.seed(static_cast<std::uint64_t>(get_parameter("seed").as_int()));
    const std::vector<std::string> ids = get_parameter("drone_ids").as_string_array();
    for (const auto & id : ids) {
      Track tr;
      tr.pub = create_publisher<aeropact_interfaces::msg::ProximityArray>(
        "/" + id + "/sensing/contacts", rclcpp::SensorDataQoS());
      tracks_[id] = tr;
      subs_.push_back(create_subscription<nav_msgs::msg::Odometry>(
          "/" + id + "/odom", rclcpp::SensorDataQoS(),
          [this, id](nav_msgs::msg::Odometry::ConstSharedPtr m) {
            Track & t = tracks_[id];
            t.pos = {m->pose.pose.position.x, m->pose.pose.position.y, m->pose.pose.position.z};
            const auto & q = m->pose.pose.orientation;
            const double yaw = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
            1.0 - 2.0 * (q.y * q.y + q.z * q.z));
            const auto & l = m->twist.twist.linear;
            t.vel = {std::cos(yaw) * l.x - std::sin(yaw) * l.y,
              std::sin(yaw) * l.x + std::cos(yaw) * l.y, l.z};
            t.valid = true;
          }));
    }
    timer_ = rclcpp::create_timer(this, get_clock(),
        rclcpp::Duration::from_seconds(1.0 / get_parameter("rate_hz").as_double()),
        [this]() {step();});
  }

private:
  struct Track
  {
    geom::Vec3 pos;
    geom::Vec3 vel;
    bool valid{false};
    rclcpp::Publisher<aeropact_interfaces::msg::ProximityArray>::SharedPtr pub;
  };

  void step()
  {
    const double range = get_parameter("range_m").as_double();
    std::normal_distribution<double> np(0.0, get_parameter("position_noise_m").as_double());
    std::normal_distribution<double> nv(0.0, get_parameter("velocity_noise_mps").as_double());
    for (auto & [id, me] : tracks_) {
      if (!me.valid) {
        continue;
      }
      aeropact_interfaces::msg::ProximityArray out;
      out.header.stamp = now();
      out.header.frame_id = "map";
      for (const auto & [oid, other] : tracks_) {
        if (oid == id || !other.valid) {
          continue;
        }
        const geom::Vec3 rel = other.pos - me.pos;
        if (geom::norm(rel) > range) {
          continue;
        }
        aeropact_interfaces::msg::ProximityContact c;
        c.id = oid;
        c.relative_position.x = rel.x + np(rng_);
        c.relative_position.y = rel.y + np(rng_);
        c.relative_position.z = rel.z + np(rng_);
        const geom::Vec3 rv = other.vel - me.vel;
        c.relative_velocity.x = rv.x + nv(rng_);
        c.relative_velocity.y = rv.y + nv(rng_);
        c.relative_velocity.z = rv.z + nv(rng_);
        out.contacts.push_back(c);
      }
      me.pub->publish(out);
    }
  }

  std::mt19937_64 rng_;
  std::map<std::string, Track> tracks_;
  std::vector<rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr> subs_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::ProximitySensorNode)
