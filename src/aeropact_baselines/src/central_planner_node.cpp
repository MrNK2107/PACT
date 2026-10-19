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
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "aeropact_agent/conversions.hpp"
#include "aeropact_baselines/global_assignment.hpp"
#include "aeropact_core/json.hpp"
#include "aeropact_core/merge.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/msg/assignment_array.hpp"
#include "aeropact_interfaces/msg/drone_state.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/task_record.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"

namespace aeropact::baselines
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using core::Activity;
using core::TaskState;
namespace conv = aeropact::agent;

/**
 * Central hub planner. Receives orders from the depots and telemetry from the drones over a
 * reliable long-range uplink, assigns work globally every period and broadcasts the assignments
 * (also as a liveness beacon). Deactivating the node is the `kill_service(central_hub)` fault: from
 * then on drones finish what they hold and park (05 5.2, central_hub_loss).
 */
class CentralPlannerNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit CentralPlannerNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("central_planner", options)
  {
    declare_parameter("world_file", "");
    declare_parameter("period_s", 2.0);
    declare_parameter("cruise_alt_m", 38.0);
    declare_parameter("battery_wh", 60.0);
    declare_parameter("min_soc", 0.35);
    declare_parameter("stale_s", 30.0);
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    world_ = std::make_unique<core::WorldModel>(
      core::WorldModel::load(get_parameter("world_file").as_string()));
    core::EnergyParams ep;
    ep.battery_wh = get_parameter("battery_wh").as_double();
    energy_ = std::make_unique<core::EnergyModel>(ep);
    orders_sub_ = create_subscription<aeropact_interfaces::msg::TaskRecord>("/hub/orders",
        rclcpp::QoS(100).reliable(),
        [this](aeropact_interfaces::msg::TaskRecord::ConstSharedPtr m) {
          if (!active_) {
            return;
          }
          core::Task t = conv::from_msg(*m);
          tasks_.emplace(t.task_id, t);
        });
    updates_sub_ = create_subscription<aeropact_interfaces::msg::TaskRecord>("/hub/task_updates",
        rclcpp::QoS(100).reliable(),
        [this](aeropact_interfaces::msg::TaskRecord::ConstSharedPtr m) {
          if (!active_) {
            return;
          }
          // Same join as the fleet replicas: newer fencing epochs and progress always win, so a
          // drone handing a task back (newer epoch, UNASSIGNED) is understood by the hub.
          core::Task t = conv::from_msg(*m);
          auto it = tasks_.find(t.task_id);
          if (it == tasks_.end()) {
            tasks_.emplace(t.task_id, t);
          } else {
            // A drone handing back its own assignment declined it: bench that drone briefly.
            if (t.state == TaskState::kUnassigned && !it->second.owner.empty() &&
            t.claim_epoch > it->second.claim_epoch)
            {
              declined_at_[it->second.owner] = now().seconds();
            }
            it->second = core::merge_task(it->second, t);
          }
        });
    telemetry_sub_ = create_subscription<aeropact_interfaces::msg::DroneState>("/hub/telemetry",
        rclcpp::QoS(50), [this](aeropact_interfaces::msg::DroneState::ConstSharedPtr m) {
          if (!active_) {
            return;
          }
          Seen s;
          s.info = conv::from_msg(*m);
          s.t = now().seconds();
          drones_[m->drone_id] = s;
        });
    assign_pub_ = create_publisher<aeropact_interfaces::msg::AssignmentArray>("/hub/assignments",
        rclcpp::QoS(10).reliable());
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>("/fleet/events",
        rclcpp::QoS(500).reliable());
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    assign_pub_->on_activate();
    events_->on_activate();
    active_ = true;
    timer_ = rclcpp::create_timer(this, get_clock(),
        rclcpp::Duration::from_seconds(get_parameter("period_s").as_double()),
        [this]() {plan();});
    emit("HUB_UP", core::Json());
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    emit("HUB_DOWN", core::Json().add("open_tasks", static_cast<uint64_t>(open_count())));
    active_ = false;
    if (timer_) {
      timer_->cancel();
    }
    assign_pub_->on_deactivate();
    events_->on_deactivate();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    tasks_.clear();
    drones_.clear();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  struct Seen
  {
    core::DroneInfo info;
    double t{0.0};
  };

  std::size_t open_count() const
  {
    return static_cast<std::size_t>(std::count_if(tasks_.begin(), tasks_.end(),
           [](const auto & kv) {return kv.second.state == TaskState::kUnassigned;}));
  }

  void plan()
  {
    const double t = now().seconds();
    const double stale = get_parameter("stale_s").as_double();
    // Drones gone silent lose their pre-pickup assignments (the hub has full information).
    for (auto & [tid, task] : tasks_) {
      if (task.state != TaskState::kCommitted) {
        continue;
      }
      auto d = drones_.find(task.owner);
      if (d == drones_.end() || t - d->second.t > stale) {
        task.state = TaskState::kUnassigned;
        task.owner.clear();
      }
    }
    std::vector<IdleDrone> idle;
    for (const auto & [id, s] : drones_) {
      const auto a = s.info.activity;
      const bool free_now = (a == Activity::kIdle || a == Activity::kCharging ||
        a == Activity::kHolding) && s.info.bundle.empty();
      const bool pending = std::any_of(tasks_.begin(), tasks_.end(), [&id](const auto & kv) {
            return kv.second.owner == id && kv.second.state == TaskState::kCommitted;
          });
      auto dec = declined_at_.find(id);
      const bool benched = dec != declined_at_.end() && t - dec->second < 30.0;
      if (t - s.t < 3.0 && free_now && !pending && !benched &&
        s.info.soc >= get_parameter("min_soc").as_double())
      {
        idle.push_back({id, s.info.position, s.info.soc, s.info.capacity_kg});
      }
    }
    std::vector<core::Task> open;
    for (const auto & [tid, task] : tasks_) {
      if (task.state == TaskState::kUnassigned) {
        open.push_back(task);
      }
    }
    aeropact_interfaces::msg::AssignmentArray arr;
    arr.header.stamp = now();
    const auto pairs = assign_greedy(idle, open, *energy_, world_->wind,
        get_parameter("cruise_alt_m").as_double(), t);
    for (const auto & [drone, tid] : pairs) {
      core::Task & task = tasks_.at(tid);
      task.claim_epoch = std::max(task.epoch, task.claim_epoch) + 1;
      task.epoch = task.claim_epoch;
      task.state = TaskState::kCommitted;
      task.owner = drone;
      aeropact_interfaces::msg::Assignment a;
      a.drone_id = drone;
      a.task_id = tid;
      a.epoch = task.claim_epoch;
      a.task = conv::to_msg(task);
      arr.assignments.push_back(a);
      emit("HUB_ASSIGN", core::Json().add("task_id", tid).add("drone", drone)
        .add("epoch", task.claim_epoch));
    }
    // Re-send standing assignments so a lost message does not strand a task.
    for (const auto & [tid, task] : tasks_) {
      if (task.state == TaskState::kCommitted &&
        std::none_of(pairs.begin(), pairs.end(), [&tid](const auto & p) {return p.second == tid;}))
      {
        aeropact_interfaces::msg::Assignment a;
        a.drone_id = task.owner;
        a.task_id = tid;
        a.epoch = task.claim_epoch;
        a.task = conv::to_msg(task);
        arr.assignments.push_back(a);
      }
    }
    assign_pub_->publish(arr);
  }

  void emit(const std::string & type, const core::Json & data)
  {
    if (!events_ || !events_->is_activated()) {
      return;
    }
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = "hub";
    ev.type = type;
    ev.data = data.str();
    events_->publish(ev);
  }

  bool active_{false};
  std::unique_ptr<core::WorldModel> world_;
  std::unique_ptr<core::EnergyModel> energy_;
  std::map<std::string, core::Task> tasks_;
  std::map<std::string, Seen> drones_;
  std::map<std::string, double> declined_at_;
  rclcpp::Subscription<aeropact_interfaces::msg::TaskRecord>::SharedPtr orders_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::TaskRecord>::SharedPtr updates_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::DroneState>::SharedPtr telemetry_sub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::AssignmentArray>::SharedPtr
    assign_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::baselines

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::baselines::CentralPlannerNode)
