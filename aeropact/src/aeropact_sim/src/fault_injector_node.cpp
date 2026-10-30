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

#include <yaml-cpp/yaml.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_core/json.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/msg/airspace_restriction_array.hpp"
#include "aeropact_interfaces/msg/coordinator_status.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_sim/yaml_json.hpp"
#include "lifecycle_msgs/msg/transition.hpp"
#include "lifecycle_msgs/srv/change_state.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"

namespace aeropact::sim
{

using InjectFault = aeropact_interfaces::srv::InjectFault;
using ChangeState = lifecycle_msgs::srv::ChangeState;

/**
 * Scripted fault injection (REQ-SIM-004). Reads the `faults:` list of the scenario file and fires
 * each fault at its simulation time by calling the owning component: the radio medium (partition,
 * link_loss, loss, asymmetric_link, heal), the vehicle plant (kill_drone motors, battery_drain,
 * pad/depot power), the depots (depot_outage, pad_outage), the agents (clock_drift, distress,
 * radio_silence, lifecycle deactivation on kill_drone), the hub (kill_service) and the workload
 * generator (urgent_job_burst). It is also the airspace authority for close_zone restrictions.
 * Every fault and every restore is logged as an event.
 */
class FaultInjectorNode : public rclcpp::Node
{
public:
  explicit FaultInjectorNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("fault_injector", options)
  {
    declare_parameter("scenario_file", "");
    declare_parameter("world_file", "");
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    airspace_pub_ = create_publisher<aeropact_interfaces::msg::AirspaceRestrictionArray>(
      "/airspace/restrictions", rclcpp::QoS(1).transient_local().reliable());
    declare_parameter("drone_ids", std::vector<std::string>{});
    const std::vector<std::string> drones = get_parameter("drone_ids").as_string_array();
    for (const auto & d : drones) {
      status_subs_.push_back(create_subscription<aeropact_interfaces::msg::CoordinatorStatus>(
          "/" + d + "/status", rclcpp::QoS(5),
          [this, d](aeropact_interfaces::msg::CoordinatorStatus::ConstSharedPtr m) {
            activity_[d] = m->activity;
          }));
    }
    load();
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(0.1),
        [this]() {step();});
  }

private:
  struct Scheduled
  {
    double t;
    std::string type;
    std::string args;  ///< owned JSON; yaml-cpp nodes alias under STL assignment
    bool restore{false};
  };

  void load()
  {
    const std::string world_file = get_parameter("world_file").as_string();
    if (!world_file.empty()) {
      world_ = std::make_unique<core::WorldModel>(core::WorldModel::load(world_file));
      // Publish closable zones known to the map as inactive, so every subscriber has the set.
      for (const auto & z : world_->no_fly) {
        if (!z.active) {
          zones_[z.id] = to_msg(z);
        }
      }
    }
    const std::string file = get_parameter("scenario_file").as_string();
    if (file.empty()) {
      return;
    }
    const YAML::Node root = YAML::LoadFile(file);
    for (const auto & f : root["faults"]) {
      Scheduled s;
      s.t = f["t"].as<double>();
      s.type = f["type"].as<std::string>();
      s.args = to_json(f);
      schedule_.push_back(s);
    }
    std::stable_sort(schedule_.begin(), schedule_.end(),
      [](const Scheduled & a, const Scheduled & b) {return a.t < b.t;});
    RCLCPP_INFO(get_logger(), "fault script: %zu faults", schedule_.size());
  }

  void step()
  {
    const double t = now().seconds();
    if (t <= 0.0) {
      return;
    }
    if (!published_initial_) {
      published_initial_ = true;
      publish_airspace();
    }
    std::vector<Retry> due;
    for (auto it = retries_.begin(); it != retries_.end(); ) {
      if (it->at <= t) {
        due.push_back(*it);
        it = retries_.erase(it);
      } else {
        ++it;
      }
    }
    for (const auto & r : due) {
      call(r.service, r.type, r.args);
    }
    while (!schedule_.empty() && schedule_.front().t <= t) {
      Scheduled s = schedule_.front();
      schedule_.erase(schedule_.begin());
      fire(s, t);
    }
  }

  /// End time of a fault: explicit `until`, or `t + duration_s`, or none (< 0).
  static double until_of(const YAML::Node & a)
  {
    if (a["until"]) {
      return a["until"].as<double>();
    }
    if (a["duration_s"]) {
      return a["t"].as<double>() + a["duration_s"].as<double>();
    }
    return -1.0;
  }

  void restore_later(const Scheduled & s, double until)
  {
    if (until < 0.0) {
      return;
    }
    Scheduled r = s;
    r.t = until;
    r.restore = true;
    auto pos = std::upper_bound(schedule_.begin(), schedule_.end(), r,
        [](const Scheduled & a, const Scheduled & b) {return a.t < b.t;});
    schedule_.insert(pos, r);
  }

  /// Resolve conditional targets before anything is logged. Returns false to retry later.
  bool resolve(Scheduled & s, double t)
  {
    YAML::Node a = parse_args(s.args);
    if (!a["id"] || a["id"].as<std::string>() != "any_carrying") {
      return true;
    }
    // The first drone (by id) currently flying a parcel to its drop.
    for (const auto & [drone, activity] : activity_) {
      if (activity == kActivityToDrop) {
        a["id"] = drone;
        s.args = to_json(a);
        return true;
      }
    }
    Scheduled retry = s;
    retry.t = t + 1.0;
    auto pos = std::upper_bound(schedule_.begin(), schedule_.end(), retry,
        [](const Scheduled & x, const Scheduled & y) {return x.t < y.t;});
    schedule_.insert(pos, retry);
    return false;
  }

  void fire(Scheduled s, double t)
  {
    if (!resolve(s, t)) {
      return;
    }
    const YAML::Node a = parse_args(s.args);
    const double until = until_of(a);
    YAML::Node args(YAML::NodeType::Map);
    for (const auto & kv : a) {
      const auto key = kv.first.as<std::string>();
      if (key != "t" && key != "type" && key != "duration_s") {
        args[key] = kv.second;
      }
    }
    if (until >= 0.0) {
      args["until"] = until;
    }
    if (s.restore) {
      args["restore"] = true;
    }
    const std::string json = to_json(args);
    emit(s.restore ? "FAULT_RESTORED" : "FAULT_INJECTED",
      core::Json().add("fault", s.type).add("t_script", s.t).raw("args", json));
    RCLCPP_WARN(get_logger(), "[t=%.1f] %s %s %s", t, s.restore ? "restore" : "inject",
      s.type.c_str(), json.c_str());

    try {
      if (s.type == "partition" || s.type == "link_loss" || s.type == "loss" ||
        s.type == "asymmetric_link" || s.type == "heal")
      {
        if (!s.restore) {
          call("/sim/radio/inject_fault", s.type, json);  // the medium expires these itself
        }
      } else if (s.type == "kill_drone") {
        const std::string id = a["id"].as<std::string>();
        if (a["distress"] && a["distress"].as<bool>()) {
          call("/" + id + "/coordinator/inject_fault", "distress", "{}");
        }
        call("/sim/plant/inject_fault", "kill_drone", json);
        // The companion computer dies with the vehicle.
        for (const auto & n : {"coordinator", "flight_manager", "safety_supervisor"}) {
          lifecycle("/" + id + "/" + n, lifecycle_msgs::msg::Transition::TRANSITION_DEACTIVATE);
        }
      } else if (s.type == "battery_drain") {
        call("/sim/plant/inject_fault", "battery_drain", json);
      } else if (s.type == "set_soc") {
        call("/sim/plant/inject_fault", "set_soc", json);
      } else if (s.type == "clock_drift") {
        call("/" + a["id"].as<std::string>() + "/coordinator/inject_fault", "clock_drift", json);
      } else if (s.type == "radio_silence") {
        call("/" + a["id"].as<std::string>() + "/coordinator/inject_fault", "radio_silence",
          s.restore ? "{\"silent\":false}" : "{\"silent\":true}");
        restore_later(s, s.restore ? -1.0 : until);
      } else if (s.type == "kill_service") {
        const std::string name = a["name"] ? a["name"].as<std::string>() : "central_hub";
        lifecycle(name == "central_hub" ? "/hub/central_planner" : name,
          lifecycle_msgs::msg::Transition::TRANSITION_DEACTIVATE);
      } else if (s.type == "depot_outage") {
        const std::string id = a["id"].as<std::string>();
        call("/depots/" + id + "/inject_fault", "depot_outage", json);
        call("/sim/plant/inject_fault", "depot_outage", json);
        restore_later(s, s.restore ? -1.0 : until);
      } else if (s.type == "pad_outage") {
        const std::string pad = a["pad"].as<std::string>();
        const core::Pad * p = world_ ? world_->pad(pad) : nullptr;
        if (p != nullptr && !p->depot_id.empty()) {
          call("/depots/" + p->depot_id + "/inject_fault", "pad_outage", json);
        }
        call("/sim/plant/inject_fault", "pad_outage", json);
        restore_later(s, s.restore ? -1.0 : until);
      } else if (s.type == "close_zone") {
        close_zone(a, !s.restore);
        restore_later(s, s.restore ? -1.0 : until);
      } else if (s.type == "urgent_job_burst") {
        call("/sim/workload/inject_fault", "urgent_job_burst", json);
      } else {
        emit("FAULT_UNSUPPORTED", core::Json().add("fault", s.type));
      }
    } catch (const std::exception & e) {
      RCLCPP_ERROR(get_logger(), "fault %s failed: %s", s.type.c_str(), e.what());
      emit("FAULT_FAILED", core::Json().add("fault", s.type).add("error", e.what()));
    }
  }

  void close_zone(const YAML::Node & a, bool active)
  {
    const std::string id = a["id"].as<std::string>();
    aeropact_interfaces::msg::AirspaceRestriction r;
    auto known = zones_.find(id);
    if (known != zones_.end()) {
      r = known->second;
    }
    r.id = id;
    if (a["polygon"]) {
      r.polygon.clear();
      for (const auto & v : a["polygon"]) {
        geometry_msgs::msg::Point p;
        p.x = v[0].as<double>();
        p.y = v[1].as<double>();
        r.polygon.push_back(p);
      }
    } else if (a["circle"]) {
      r.polygon.clear();
      const double cx = a["circle"]["center"][0].as<double>();
      const double cy = a["circle"]["center"][1].as<double>();
      const double rad = a["circle"]["radius"].as<double>();
      for (const auto & v : geom::circle_polygon(cx, cy, rad, 20)) {
        geometry_msgs::msg::Point p;
        p.x = v.x;
        p.y = v.y;
        r.polygon.push_back(p);
      }
    }
    if (r.polygon.empty()) {
      throw std::runtime_error("close_zone needs a known zone id, polygon or circle");
    }
    r.floor_m = a["floor_m"] ? a["floor_m"].as<double>() : 0.0;
    r.ceiling_m = a["ceiling_m"] ? a["ceiling_m"].as<double>() : 0.0;
    r.active = active;
    r.reason = a["reason"] ? a["reason"].as<std::string>() : "scenario";
    zones_[id] = r;
    publish_airspace();
  }

  aeropact_interfaces::msg::AirspaceRestriction to_msg(const core::NoFlyZone & z)
  {
    aeropact_interfaces::msg::AirspaceRestriction r;
    r.id = z.id;
    for (const auto & v : z.polygon) {
      geometry_msgs::msg::Point p;
      p.x = v.x;
      p.y = v.y;
      r.polygon.push_back(p);
    }
    r.floor_m = z.floor_m;
    r.ceiling_m = z.ceiling_m < 1e8 ? z.ceiling_m : 0.0;
    r.active = z.active;
    r.reason = z.reason;
    return r;
  }

  void publish_airspace()
  {
    aeropact_interfaces::msg::AirspaceRestrictionArray arr;
    arr.header.stamp = now();
    arr.header.frame_id = "map";
    for (const auto & [id, r] : zones_) {
      arr.restrictions.push_back(r);
    }
    airspace_pub_->publish(arr);
  }

  void call(const std::string & service, const std::string & type, const std::string & args)
  {
    auto & client = clients_[service];
    if (!client) {
      client = create_client<InjectFault>(service);
    }
    if (!client->service_is_ready()) {
      // A target that is briefly unavailable (still starting, restarting) is retried for a while.
      const double t = now().seconds();
      if (attempts_[service + type + args] == 0.0) {
        attempts_[service + type + args] = t;
      }
      if (t - attempts_[service + type + args] < 30.0) {
        retries_.push_back({t + 1.0, service, type, args});
        return;
      }
      RCLCPP_WARN(get_logger(), "service %s not available for %s", service.c_str(),
        type.c_str());
      emit("FAULT_FAILED", core::Json().add("fault", type).add("service", service)
        .add("error", "service unavailable"));
      return;
    }
    auto req = std::make_shared<InjectFault::Request>();
    req->type = type;
    req->args = args;
    client->async_send_request(req,
      [this, service, type](rclcpp::Client<InjectFault>::SharedFuture f) {
        if (!f.get()->success) {
          RCLCPP_WARN(get_logger(), "%s rejected %s: %s", service.c_str(), type.c_str(),
          f.get()->message.c_str());
        }
      });
  }

  void lifecycle(const std::string & node, uint8_t transition)
  {
    auto & client = lifecycle_clients_[node];
    if (!client) {
      client = create_client<ChangeState>(node + "/change_state");
    }
    if (!client->service_is_ready()) {
      RCLCPP_WARN(get_logger(), "lifecycle service of %s not available", node.c_str());
      return;
    }
    auto req = std::make_shared<ChangeState::Request>();
    req->transition.id = transition;
    client->async_send_request(req, [](rclcpp::Client<ChangeState>::SharedFuture) {});
  }

  void emit(const std::string & type, const core::Json & data)
  {
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = "fault_injector";
    ev.type = type;
    ev.data = data.str();
    events_->publish(ev);
  }

  static constexpr uint8_t kActivityToDrop = 3;  // DroneState.ACTIVITY_TO_DROP

  struct Retry
  {
    double at;
    std::string service;
    std::string type;
    std::string args;
  };
  std::vector<Retry> retries_;
  std::map<std::string, double> attempts_;

  std::unique_ptr<core::WorldModel> world_;
  std::vector<Scheduled> schedule_;
  std::map<std::string, uint8_t> activity_;
  std::vector<rclcpp::Subscription<aeropact_interfaces::msg::CoordinatorStatus>::SharedPtr>
  status_subs_;
  std::map<std::string, aeropact_interfaces::msg::AirspaceRestriction> zones_;
  bool published_initial_{false};
  std::map<std::string, rclcpp::Client<InjectFault>::SharedPtr> clients_;
  std::map<std::string, rclcpp::Client<ChangeState>::SharedPtr> lifecycle_clients_;
  rclcpp::Publisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::Publisher<aeropact_interfaces::msg::AirspaceRestrictionArray>::SharedPtr airspace_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::FaultInjectorNode)
