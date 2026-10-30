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
#include <random>
#include <string>
#include <vector>

#include "aeropact_core/json.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_interfaces/srv/submit_order.hpp"
#include "aeropact_sim/yaml_json.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"

namespace aeropact::sim
{

using SubmitOrder = aeropact_interfaces::srv::SubmitOrder;

/**
 * Order stream (REQ-SIM-005): Poisson arrivals over clustered demand (drop points carry demand
 * weights), a priority mix with medical drops leaning urgent, per-priority deadlines, and scripted
 * orders from the scenario file. Orders enter at the depot whose catchment holds the drop point.
 * Seeded; arrival times are drawn in simulation time.
 */
class WorkloadGeneratorNode : public rclcpp::Node
{
public:
  explicit WorkloadGeneratorNode(const rclcpp::NodeOptions & options)
  : rclcpp::Node("workload_generator", options)
  {
    declare_parameter("world_file", "");
    declare_parameter("scenario_file", "");
    declare_parameter("seed", 42);
    declare_parameter("arrival_rate_per_min", 2.0);
    declare_parameter("priority_mix", std::vector<double>{0.1, 0.3, 0.6});
    declare_parameter("deadline_s", std::vector<double>{420.0, 900.0, 1500.0});
    declare_parameter("weight_kg", std::vector<double>{0.3, 1.8});
    declare_parameter("start_s", 10.0);
    declare_parameter("stop_s", 1e9);
    world_ = std::make_unique<core::WorldModel>(
      core::WorldModel::load(get_parameter("world_file").as_string()));
    rng_.seed(static_cast<std::uint64_t>(get_parameter("seed").as_int()));
    for (const auto & d : world_->depots) {
      clients_[d.id] = create_client<SubmitOrder>("/depots/" + d.id + "/submit_order");
    }
    std::vector<double> w;
    for (const auto & dp : world_->drop_points) {
      w.push_back(dp.weight);
    }
    if (!w.empty()) {
      pick_drop_ = std::discrete_distribution<std::size_t>(w.begin(), w.end());
    }
    load_script();
    next_arrival_ = get_parameter("start_s").as_double();
    draw_next(next_arrival_);
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    fault_srv_ = create_service<aeropact_interfaces::srv::InjectFault>(
      "/sim/workload/inject_fault",
      [this](const std::shared_ptr<aeropact_interfaces::srv::InjectFault::Request> rq,
      std::shared_ptr<aeropact_interfaces::srv::InjectFault::Response> rs) {on_fault(*rq, *rs);});
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(0.1),
        [this]() {step();});
  }

private:
  struct Order
  {
    double t;
    std::string drop_id;
    int priority;
    double deadline_offset;
    double weight;
    std::string origin;
  };

  void load_script()
  {
    const std::string file = get_parameter("scenario_file").as_string();
    if (file.empty()) {
      return;
    }
    const YAML::Node root = YAML::LoadFile(file);
    const YAML::Node orders = root["workload"] ? root["workload"]["orders"] : YAML::Node();
    for (const auto & o : orders) {
      Order ord = random_order(o["t"].as<double>(), 0);
      if (o["drop_id"]) {
        ord.drop_id = o["drop_id"].as<std::string>();
      }
      if (o["priority"]) {
        ord.priority = o["priority"].as<int>();
        ord.deadline_offset = deadline_for(ord.priority);
      }
      if (o["deadline_offset_s"]) {
        ord.deadline_offset = o["deadline_offset_s"].as<double>();
      }
      if (o["weight_kg"]) {
        ord.weight = o["weight_kg"].as<double>();
      }
      if (o["origin_depot"]) {
        ord.origin = o["origin_depot"].as<std::string>();
      }
      scripted_.push_back(ord);
    }
    std::stable_sort(scripted_.begin(), scripted_.end(),
      [](const Order & a, const Order & b) {return a.t < b.t;});
  }

  double deadline_for(int priority) const
  {
    const std::vector<double> d = get_parameter("deadline_s").as_double_array();
    return d.at(static_cast<std::size_t>(std::clamp(priority, 1, 3) - 1));
  }

  Order random_order(double t, int forced_priority, const std::string & kind = "")
  {
    Order o;
    o.t = t;
    const core::DropPoint * dp = nullptr;
    if (!kind.empty()) {
      std::vector<const core::DropPoint *> matching;
      for (const auto & d : world_->drop_points) {
        if (d.kind == kind) {
          matching.push_back(&d);
        }
      }
      if (!matching.empty()) {
        std::uniform_int_distribution<std::size_t> u(0, matching.size() - 1);
        dp = matching[u(rng_)];
      }
    }
    if (dp == nullptr && !world_->drop_points.empty()) {
      dp = &world_->drop_points[pick_drop_(rng_)];
    }
    o.drop_id = dp != nullptr ? dp->id : "";
    std::vector<double> mix = get_parameter("priority_mix").as_double_array();
    mix.resize(3, 0.0);
    if (dp != nullptr && (dp->kind == "hospital" || dp->kind == "clinic")) {
      mix[0] *= 3.0;  // medical demand leans urgent
    }
    std::discrete_distribution<int> pd(mix.begin(), mix.end());
    o.priority = forced_priority > 0 ? forced_priority : pd(rng_) + 1;
    o.deadline_offset = deadline_for(o.priority);
    const std::vector<double> wr = get_parameter("weight_kg").as_double_array();
    std::uniform_real_distribution<double> wd(wr.at(0), wr.at(1));
    o.weight = std::round(wd(rng_) * 10.0) / 10.0;
    return o;
  }

  void draw_next(double from)
  {
    const double rate = get_parameter("arrival_rate_per_min").as_double() / 60.0;
    if (rate <= 0.0) {
      next_arrival_ = 1e18;
      return;
    }
    std::exponential_distribution<double> e(rate);
    next_arrival_ = from + e(rng_);
  }

  void step()
  {
    const double t = now().seconds();
    if (t <= 0.0) {
      return;
    }
    while (!scripted_.empty() && scripted_.front().t <= t) {
      submit(scripted_.front());
      scripted_.erase(scripted_.begin());
    }
    while (!burst_.empty() && burst_.front().t <= t) {
      submit(burst_.front());
      burst_.erase(burst_.begin());
    }
    const double stop = get_parameter("stop_s").as_double();
    while (next_arrival_ <= t && next_arrival_ <= stop) {
      submit(random_order(next_arrival_, 0));
      draw_next(next_arrival_);
    }
  }

  void submit(const Order & o)
  {
    const core::DropPoint * dp = world_->drop_point(o.drop_id);
    if (dp == nullptr) {
      return;
    }
    std::string origin = o.origin;
    if (origin.empty()) {
      const core::Depot * d = world_->nearest_depot(dp->position);
      origin = d != nullptr ? d->id : "";
    }
    auto it = clients_.find(origin);
    if (it == clients_.end() || !it->second->service_is_ready()) {
      // Intake falls back to the next depot: losing one intake point does not stop orders.
      for (const auto & [id, c] : clients_) {
        if (c->service_is_ready()) {
          it = clients_.find(id);
          break;
        }
      }
      if (it == clients_.end() || !it->second->service_is_ready()) {
        emit("ORDER_REJECTED", core::Json().add("drop_id", o.drop_id).add("reason", "no depot"));
        return;
      }
    }
    auto req = std::make_shared<SubmitOrder::Request>();
    req->drop.x = dp->position.x;
    req->drop.y = dp->position.y;
    req->drop.z = dp->position.z;
    req->drop_id = dp->id;
    req->priority = static_cast<uint8_t>(o.priority);
    req->deadline_offset_s = o.deadline_offset;
    req->weight_kg = static_cast<float>(o.weight);
    const std::string drop = dp->id;
    it->second->async_send_request(req, [this, drop](rclcpp::Client<SubmitOrder>::SharedFuture f) {
        if (!f.get()->accepted) {
          emit("ORDER_REJECTED", core::Json().add("drop_id", drop).add("reason", f.get()->reason));
        }
      });
  }

  void on_fault(
    const aeropact_interfaces::srv::InjectFault::Request & rq,
    aeropact_interfaces::srv::InjectFault::Response & rs)
  {
    if (rq.type != "urgent_job_burst") {
      rs.success = false;
      rs.message = "unknown workload fault";
      return;
    }
    const YAML::Node a = parse_args(rq.args);
    const int count = a["count"] ? a["count"].as<int>() : 10;
    const double window = a["window_s"] ? a["window_s"].as<double>() : 60.0;
    const std::string kind = a["kind"] ? a["kind"].as<std::string>() : "hospital";
    const double t = now().seconds();
    for (int i = 0; i < count; ++i) {
      burst_.push_back(random_order(t + window * i / std::max(1, count), 1, kind));
    }
    std::stable_sort(burst_.begin(), burst_.end(),
      [](const Order & x, const Order & y) {return x.t < y.t;});
    rs.success = true;
    rs.message = std::to_string(count) + " urgent orders scheduled";
  }

  void emit(const std::string & type, const core::Json & data)
  {
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = "workload";
    ev.type = type;
    ev.data = data.str();
    events_->publish(ev);
  }

  std::unique_ptr<core::WorldModel> world_;
  std::mt19937_64 rng_;
  std::discrete_distribution<std::size_t> pick_drop_;
  std::vector<Order> scripted_;
  std::vector<Order> burst_;
  double next_arrival_{0.0};
  std::map<std::string, rclcpp::Client<SubmitOrder>::SharedPtr> clients_;
  rclcpp::Publisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::Service<aeropact_interfaces::srv::InjectFault>::SharedPtr fault_srv_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::sim

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::sim::WorkloadGeneratorNode)
