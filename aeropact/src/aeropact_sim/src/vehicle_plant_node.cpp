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
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_core/json.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/msg/airspace_restriction_array.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/pad_occupancy.hpp"
#include "aeropact_interfaces/msg/payload_event.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_sim/battery_model.hpp"
#include "aeropact_sim/yaml_json.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "sensor_msgs/msg/battery_state.hpp"
#include "std_msgs/msg/bool.hpp"

namespace aeropact::sim
{

/**
 * Vehicle plant: everything physical about the drones that the physics backend does not model.
 *   - ground-truth battery per drone (discharge, charging on powered pads, drain faults),
 *   - parcel mass carried (from hand-off and release events),
 *   - hard failures: depleted battery or kill_drone cut the motors,
 *   - ground-truth safety monitor: collisions, no-fly and geofence violations, crashes (M5).
 */
class VehiclePlantNode : public rclcpp::Node
{
public:
  explicit VehiclePlantNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("vehicle_plant", options)
  {
    declare_parameter("drone_ids", std::vector<std::string>{});
    declare_parameter("world_file", "");
    declare_parameter("initial_soc", std::vector<double>{});
    declare_parameter("battery_wh", 60.0);
    declare_parameter("charge_time_s", 240.0);
    declare_parameter("collision_radius_m", 1.0);
    declare_parameter("ground_z", 0.0);
    // Ground truth for the plant: "odom" on backends whose odometry is truth; "ground_truth/odom"
    // when the vehicle odometry is an autopilot estimate (px4 backend).
    declare_parameter("odom_topic", "odom");
    // How a hard failure cuts the motors: empty publishes enable=false to the flight controller
    // model; a topic name (px4: "sim/motor_cut") requests flight termination from the autopilot.
    declare_parameter("motor_cut_topic", "");
    // Simulated depot pad sensors (D-31), from ground truth; empty disables.
    declare_parameter("pad_sensor_topic", "/sim/pad_occupancy");
    world_ = std::make_unique<core::WorldModel>(
      core::WorldModel::load(get_parameter("world_file").as_string()));
    for (const auto & p : world_->pads) {
      powered_[p.id] = true;
    }
    const std::vector<std::string> ids = get_parameter("drone_ids").as_string_array();
    const std::vector<double> soc0 = get_parameter("initial_soc").as_double_array();
    BatteryParams bp;
    bp.capacity_wh = get_parameter("battery_wh").as_double();
    bp.charge_time_s = get_parameter("charge_time_s").as_double();
    const std::string odom_topic = get_parameter("odom_topic").as_string();
    motor_cut_topic_ = get_parameter("motor_cut_topic").as_string();
    for (std::size_t i = 0; i < ids.size(); ++i) {
      Vehicle v;
      v.id = ids[i];
      v.battery = BatteryModel(bp, i < soc0.size() ? soc0[i] : (soc0.empty() ? 1.0 : soc0.back()));
      v.battery_pub = create_publisher<sensor_msgs::msg::BatteryState>("/" + v.id + "/battery", 5);
      v.enable_pub = create_publisher<std_msgs::msg::Bool>(
        "/" + v.id + "/" + (motor_cut_topic_.empty() ? std::string("enable") : motor_cut_topic_),
        5);
      vehicles_[v.id] = std::move(v);
      const std::string id = ids[i];
      odom_subs_.push_back(create_subscription<nav_msgs::msg::Odometry>(
          "/" + id + "/" + odom_topic, rclcpp::SensorDataQoS(),
          [this, id](nav_msgs::msg::Odometry::ConstSharedPtr m) {
            Vehicle & veh = vehicles_[id];
            veh.pos = {m->pose.pose.position.x, m->pose.pose.position.y, m->pose.pose.position.z};
            const auto & q = m->pose.pose.orientation;
            const double yaw = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
            1.0 - 2.0 * (q.y * q.y + q.z * q.z));
            const auto & l = m->twist.twist.linear;
            veh.vel = {std::cos(yaw) * l.x - std::sin(yaw) * l.y,
              std::sin(yaw) * l.x + std::cos(yaw) * l.y, l.z};
            veh.have_odom = true;
          }));
    }
    payload_sub_ = create_subscription<aeropact_interfaces::msg::PayloadEvent>(
      "/sim/payload", rclcpp::QoS(50).reliable(),
      [this](aeropact_interfaces::msg::PayloadEvent::ConstSharedPtr m) {
        auto it = vehicles_.find(m->drone_id);
        if (it == vehicles_.end()) {
          return;
        }
        if (m->attached) {
          it->second.parcels[m->task_id] = m->mass_kg;
        } else {
          it->second.parcels.erase(m->task_id);
        }
      });
    airspace_sub_ = create_subscription<aeropact_interfaces::msg::AirspaceRestrictionArray>(
      "/airspace/restrictions", rclcpp::QoS(1).transient_local().reliable(),
      [this](aeropact_interfaces::msg::AirspaceRestrictionArray::ConstSharedPtr m) {
        for (const auto & r : m->restrictions) {
          core::NoFlyZone z;
          z.id = r.id;
          for (const auto & p : r.polygon) {
            z.polygon.push_back({p.x, p.y});
          }
          z.floor_m = r.floor_m;
          z.ceiling_m = r.ceiling_m > 0.0 ? r.ceiling_m : 1e9;
          z.active = r.active;
          world_->set_restriction(z);
        }
      });
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    if (!get_parameter("pad_sensor_topic").as_string().empty()) {
      pad_pub_ = create_publisher<aeropact_interfaces::msg::PadOccupancy>(
        get_parameter("pad_sensor_topic").as_string(), rclcpp::QoS(50));
    }
    fault_srv_ = create_service<aeropact_interfaces::srv::InjectFault>("/sim/plant/inject_fault",
        [this](const std::shared_ptr<aeropact_interfaces::srv::InjectFault::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::InjectFault::Response> rs) {on_fault(*rq, *rs);});
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(0.1),
        [this]() {step();});
  }

private:
  struct Vehicle
  {
    std::string id;
    BatteryModel battery;
    geom::Vec3 pos;
    geom::Vec3 vel;
    bool have_odom{false};
    bool dead{false};
    bool was_airborne{false};
    std::map<std::string, double> parcels;
    std::set<std::string> in_zones;
    bool out_of_bounds{false};
    bool charging{false};
    rclcpp::Publisher<sensor_msgs::msg::BatteryState>::SharedPtr battery_pub;
    rclcpp::Publisher<std_msgs::msg::Bool>::SharedPtr enable_pub;
  };

  void step()
  {
    const double t = now().seconds();
    const double dt = last_ < 0.0 ? 0.0 : std::min(1.0, t - last_);
    last_ = t;
    const double ground = get_parameter("ground_z").as_double();
    for (auto & [id, v] : vehicles_) {
      if (!v.have_odom) {
        continue;
      }
      const bool airborne = v.pos.z > ground + 0.45;
      double payload = 0.0;
      for (const auto & [tid, kg] : v.parcels) {
        payload += kg;
      }
      bool charging = false;
      if (!airborne && geom::norm(v.vel) < 0.4) {
        for (const auto & p : world_->pads) {
          if (powered_[p.id] && geom::dist_xy(p.position, v.pos) < 1.8) {
            charging = true;
            break;
          }
        }
      }
      if (charging != v.charging) {
        v.charging = charging;
        emit(charging ? "CHARGING_START" : "CHARGING_END", id,
          core::Json().add("soc", v.battery.soc()));
      }
      if (!v.dead) {
        v.battery.step(dt, airborne, v.vel, world_->wind, payload, charging);
        if (v.battery.depleted()) {
          v.dead = true;
          emit("BATTERY_DEPLETED", id, core::Json().add("x", v.pos.x).add("y", v.pos.y)
            .add("z", v.pos.z).add("airborne", airborne));
        }
      }
      if (v.dead) {
        std_msgs::msg::Bool off;
        off.data = !motor_cut_topic_.empty();  // enable=false, or motor_cut=true
        v.enable_pub->publish(off);  // motors stay off
        if (v.was_airborne && !airborne && geom::norm(v.vel) < 0.5) {
          emit("CRASH", id, core::Json().add("x", v.pos.x).add("y", v.pos.y)
            .add("parcels", static_cast<uint64_t>(v.parcels.size())));
        }
      }
      if (++publish_counter_ % 5 == 0 || dt == 0.0) {
        sensor_msgs::msg::BatteryState b;
        b.header.stamp = now();
        b.percentage = static_cast<float>(v.battery.soc());
        b.voltage = static_cast<float>(v.battery.voltage());
        b.present = true;
        b.power_supply_status = charging ?
          sensor_msgs::msg::BatteryState::POWER_SUPPLY_STATUS_CHARGING :
          sensor_msgs::msg::BatteryState::POWER_SUPPLY_STATUS_DISCHARGING;
        v.battery_pub->publish(b);
      }
      check_airspace(v, airborne);
      v.was_airborne = airborne;
    }
    check_separation(ground);
    if (pad_pub_ && ++pad_counter_ % 10 == 0) {
      publish_pad_sensors(ground);
    }
  }

  /// Depot pad sensors from ground truth: a pad is occupied when a vehicle rests on it.
  void publish_pad_sensors(double ground)
  {
    for (const auto & p : world_->pads) {
      if (p.depot_id.empty()) {
        continue;  // public pads have no depot sensor
      }
      bool occupied = false;
      for (const auto & [id, v] : vehicles_) {
        if (v.have_odom && geom::dist_xy(v.pos, p.position) < 1.8 &&
          v.pos.z < p.position.z + ground + 1.0)
        {
          occupied = true;
        }
      }
      aeropact_interfaces::msg::PadOccupancy m;
      m.header.stamp = now();
      m.depot_id = p.depot_id;
      m.pad_id = p.id;
      m.occupied = occupied;
      pad_pub_->publish(m);
    }
  }

  void check_airspace(Vehicle & v, bool airborne)
  {
    if (!airborne) {
      return;
    }
    std::set<std::string> now_in;
    for (const auto & z : world_->no_fly) {
      if (z.active && v.pos.z >= z.floor_m && v.pos.z <= z.ceiling_m &&
        geom::contains(z.polygon, v.pos.x, v.pos.y))
      {
        now_in.insert(z.id);
        if (v.in_zones.count(z.id) == 0U) {
          emit("NFZ_VIOLATION", v.id, core::Json().add("zone", z.id).add("x", v.pos.x)
            .add("y", v.pos.y).add("z", v.pos.z));
        }
      }
    }
    v.in_zones = now_in;
    const bool out = !world_->bounds.contains(v.pos.x, v.pos.y);
    if (out && !v.out_of_bounds) {
      emit("GEOFENCE_VIOLATION", v.id, core::Json().add("x", v.pos.x).add("y", v.pos.y));
    }
    v.out_of_bounds = out;
  }

  void check_separation(double ground)
  {
    const double r = get_parameter("collision_radius_m").as_double();
    const double t = now().seconds();
    for (auto a = vehicles_.begin(); a != vehicles_.end(); ++a) {
      for (auto b = std::next(a); b != vehicles_.end(); ++b) {
        if (!a->second.have_odom || !b->second.have_odom) {
          continue;
        }
        if (a->second.pos.z < ground + 0.45 && b->second.pos.z < ground + 0.45) {
          continue;  // both parked
        }
        const double d = geom::dist(a->second.pos, b->second.pos);
        const auto key = std::make_pair(a->first, b->first);
        if (d < r && t - last_collision_[key] > 10.0) {
          last_collision_[key] = t;
          emit("COLLISION", a->first, core::Json().add("other", b->first).add("distance", d)
            .add("x", a->second.pos.x).add("y", a->second.pos.y).add("z", a->second.pos.z));
        }
        if (d < min_separation_) {
          min_separation_ = d;
        }
      }
    }
  }

  void on_fault(
    const aeropact_interfaces::srv::InjectFault::Request & rq,
    aeropact_interfaces::srv::InjectFault::Response & rs)
  {
    const YAML::Node a = parse_args(rq.args);
    rs.success = true;
    try {
      if (rq.type == "kill_drone") {
        auto it = vehicles_.find(a["id"].as<std::string>());
        if (it == vehicles_.end()) {
          throw std::runtime_error("unknown drone");
        }
        it->second.dead = true;
        emit("MOTORS_CUT", it->first, core::Json().add("reason", "kill_drone"));
      } else if (rq.type == "battery_drain") {
        vehicles_.at(a["id"].as<std::string>()).battery.params().drain_factor =
          a["factor"].as<double>();
      } else if (rq.type == "set_soc") {
        vehicles_.at(a["id"].as<std::string>()).battery.set_soc(a["soc"].as<double>());
      } else if (rq.type == "pad_outage") {
        powered_[a["pad"].as<std::string>()] = a["restore"] && a["restore"].as<bool>();
      } else if (rq.type == "depot_outage") {
        const core::Depot * d = world_->depot(a["id"].as<std::string>());
        if (d == nullptr) {
          throw std::runtime_error("unknown depot");
        }
        for (const auto & pid : d->pad_ids) {
          powered_[pid] = a["restore"] && a["restore"].as<bool>();
        }
      } else {
        rs.success = false;
        rs.message = "unknown plant fault " + rq.type;
      }
    } catch (const std::exception & e) {
      rs.success = false;
      rs.message = e.what();
    }
  }

  void emit(const std::string & type, const std::string & agent, const core::Json & data)
  {
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = agent;
    ev.type = type;
    ev.data = data.str();
    events_->publish(ev);
  }

  std::unique_ptr<core::WorldModel> world_;
  std::string motor_cut_topic_;
  std::map<std::string, Vehicle> vehicles_;
  std::map<std::string, bool> powered_;
  std::map<std::pair<std::string, std::string>, double> last_collision_;
  double min_separation_{1e9};
  double last_{-1.0};
  unsigned publish_counter_{0};
  std::vector<rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr> odom_subs_;
  rclcpp::Subscription<aeropact_interfaces::msg::PayloadEvent>::SharedPtr payload_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::AirspaceRestrictionArray>::SharedPtr
    airspace_sub_;
  rclcpp::Publisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::Publisher<aeropact_interfaces::msg::PadOccupancy>::SharedPtr pad_pub_;
  unsigned pad_counter_{0};
  rclcpp::Service<aeropact_interfaces::srv::InjectFault>::SharedPtr fault_srv_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::VehiclePlantNode)
