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
#include <cctype>
#include <cmath>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_agent/conversions.hpp"
#include "aeropact_core/auction.hpp"
#include "aeropact_core/clock.hpp"
#include "aeropact_core/energy.hpp"
#include "aeropact_core/failure_detector.hpp"
#include "aeropact_core/hexgrid.hpp"
#include "aeropact_core/json.hpp"
#include "aeropact_core/ownership.hpp"
#include "aeropact_core/partition_policy.hpp"
#include "aeropact_core/replica.hpp"
#include "aeropact_core/route_planner.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_interfaces/action/fly_route.hpp"
#include "aeropact_interfaces/msg/airspace_restriction_array.hpp"
#include "aeropact_interfaces/msg/assignment_array.hpp"
#include "aeropact_interfaces/msg/coordinator_status.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/payload_event.hpp"
#include "aeropact_interfaces/msg/radio_frame.hpp"
#include "aeropact_interfaces/msg/safety_status.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_interfaces/srv/request_pickup.hpp"
#include "aeropact_interfaces/srv/reserve_bay.hpp"
#include "mission.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_action/rclcpp_action.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "sensor_msgs/msg/battery_state.hpp"

namespace aeropact::agent
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using FlyRoute = aeropact_interfaces::action::FlyRoute;
using GoalHandle = rclcpp_action::ClientGoalHandle<FlyRoute>;
using RadioFrame = aeropact_interfaces::msg::RadioFrame;
using SafetyStatus = aeropact_interfaces::msg::SafetyStatus;
using core::Activity;
using core::TaskState;
using core::Vec3;

/// Allocation strategies: PACT and the decentralised baselines of the evaluation plan (05 5.2).
enum class AllocationMode { kPact, kCbbaPlain, kGreedyNearest, kCentral };

AllocationMode allocation_mode_from_string(const std::string & s)
{
  if (s == "cbba_plain") {return AllocationMode::kCbbaPlain;}
  if (s == "greedy_nearest") {return AllocationMode::kGreedyNearest;}
  if (s == "central") {return AllocationMode::kCentral;}
  return AllocationMode::kPact;
}

/**
 * Fleet coordinator: one per vehicle, on the vehicle's companion computer.
 *
 * Every tick (10 Hz, simulation time):
 *   1. process received radio frames (gossip deltas, heartbeats, probes, distress, suspicions,
 *      pad responses);
 *   2. failure detector update, membership view and link mode;
 *   3. ownership: evaluate lease confirmations, zombie-stop lapsed leases, drop lost tasks
 *      (bundle repair), renew, commit, re-open foreign leases that aged out;
 *   4. shard leases;
 *   5. allocation (periodic, or immediately on an urgent task);
 *   6. mission execution (fly to pickup, hand-off, drop, park and charge);
 *   7. heartbeat and delta gossip.
 *
 * Lease logic uses only the drifting local clock (PRD 9.2); deadlines use the fleet time base.
 */
class CoordinatorNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit CoordinatorNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("coordinator", options), hex_(150.0)
  {
    declare_parameter("drone_id", "A01");
    declare_parameter("world_file", "");
    declare_parameter("fleet_roster", std::vector<std::string>{});
    declare_parameter("depot_ids", std::vector<std::string>{});
    declare_parameter("home_pad", "");
    declare_parameter("allocation_mode", "pact");
    declare_parameter("partition_policy", "QUORUM");
    declare_parameter("bundle_len", 3);
    declare_parameter("tick_hz", 10.0);
    declare_parameter("auction_period_s", 2.0);
    declare_parameter("gossip_period_s", 1.0);
    declare_parameter("full_sync_period_s", 10.0);
    declare_parameter("heartbeat_period_s", 1.0);
    declare_parameter("lease_ttl_s", 20.0);
    declare_parameter("renew_period_s", 5.0);
    declare_parameter("drift_margin", 0.02);
    declare_parameter("grace_s", 2.0);
    declare_parameter("t_commit_s", 3.0);
    declare_parameter("shard_lease_ttl_s", 30.0);
    declare_parameter("max_optimistic_claims", 2);
    declare_parameter("use_shard_leases", true);
    declare_parameter("use_charging_penalty", true);
    declare_parameter("use_indirect_probing", true);
    declare_parameter("clock_drift_ppm", 0.0);
    declare_parameter("capacity_kg", 2.0);
    declare_parameter("cruise_speed_mps", 9.0);
    declare_parameter("cruise_alt_base_m", 32.0);
    declare_parameter("cruise_alt_spacing_m", 6.0);
    declare_parameter("cruise_layers", 4);
    declare_parameter("handoff_hover_agl_m", 3.0);
    declare_parameter("drop_hover_agl_m", 4.0);
    declare_parameter("drop_dwell_s", 3.0);
    declare_parameter("min_takeoff_soc", 0.35);
    declare_parameter("park_soc", 0.97);
    declare_parameter("battery_wh", 60.0);
    declare_parameter("hub_timeout_s", 5.0);
    declare_parameter("phi_suspect", 5.0);
    declare_parameter("phi_unreachable", 9.0);
    declare_parameter("failure_quorum", 2);
    declare_parameter("seed", 1);
  }

  // ---------------------------------------------------------------- lifecycle

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    id_ = get_parameter("drone_id").as_string();
    roster_ = get_parameter("fleet_roster").as_string_array();
    depot_ids_ = get_parameter("depot_ids").as_string_array();
    home_pad_ = get_parameter("home_pad").as_string();
    mode_ = allocation_mode_from_string(get_parameter("allocation_mode").as_string());
    const auto world_file = get_parameter("world_file").as_string();
    try {
      world_ = std::make_unique<core::WorldModel>(core::WorldModel::load(world_file));
      policy_kind_ = core::partition_policy_from_string(
        get_parameter("partition_policy").as_string());
    } catch (const std::exception & e) {
      RCLCPP_ERROR(get_logger(), "configuration failed: %s", e.what());
      return CallbackReturn::FAILURE;
    }
    hex_ = core::HexGrid(world_->shard_size_m);

    core::EnergyParams ep;
    ep.battery_wh = get_parameter("battery_wh").as_double();
    ep.cruise_speed = get_parameter("cruise_speed_mps").as_double();
    energy_ = std::make_unique<core::EnergyModel>(ep);

    cruise_alt_ = cruise_layer(id_, get_parameter("cruise_alt_base_m").as_double(),
        get_parameter("cruise_alt_spacing_m").as_double(),
        static_cast<int>(get_parameter("cruise_layers").as_int()));
    core::AuctionConfig ac;
    ac.bundle_len = static_cast<std::size_t>(std::max<int64_t>(1,
        get_parameter("bundle_len").as_int()));
    ac.cruise_alt = cruise_alt_;
    ac.use_charging_penalty = get_parameter("use_charging_penalty").as_bool();
    if (mode_ == AllocationMode::kGreedyNearest) {
      ac.bundle_len = 1;
    }
    auction_ = std::make_unique<core::Auction>(ac, *energy_, *world_);
    planner_ = std::make_unique<core::RoutePlanner>(*world_);

    core::OwnershipConfig oc;
    oc.lease_ttl = get_parameter("lease_ttl_s").as_double();
    oc.renew_period = get_parameter("renew_period_s").as_double();
    oc.drift_margin = get_parameter("drift_margin").as_double();
    oc.grace = get_parameter("grace_s").as_double();
    oc.t_commit = get_parameter("t_commit_s").as_double();
    oc.use_leases = mode_ == AllocationMode::kPact;
    own_ = std::make_unique<core::OwnershipManager>(id_, oc);
    policy_ = core::make_partition_policy(policy_kind_,
        static_cast<std::size_t>(get_parameter("max_optimistic_claims").as_int()));

    core::FailureDetectorConfig fc;
    fc.phi_suspect = get_parameter("phi_suspect").as_double();
    fc.phi_unreachable = get_parameter("phi_unreachable").as_double();
    fc.failure_quorum = static_cast<std::size_t>(get_parameter("failure_quorum").as_int());
    fc.use_indirect_probing = get_parameter("use_indirect_probing").as_bool();
    fd_ = std::make_unique<core::FailureDetector>(id_, fc);

    clock_ = core::LocalClock(get_parameter("clock_drift_ppm").as_double(), 0.0);
    replica_ = core::FleetReplica();
    use_shard_leases_ = get_parameter("use_shard_leases").as_bool() &&
      mode_ == AllocationMode::kPact;
    shard_ttl_ = get_parameter("shard_lease_ttl_s").as_double();
    if (const core::Pad * pad = world_->pad(home_pad_)) {
      pad_id_ = pad->id;
      pad_pos_ = pad->position;
      pad_granted_ = true;
      activity_ = Activity::kCharging;
    }

    // ---- interfaces ----
    const auto radio_qos = rclcpp::QoS(200).best_effort();
    radio_tx_ = create_publisher<RadioFrame>("radio/tx", radio_qos);
    radio_rx_ = create_subscription<RadioFrame>("radio/rx", radio_qos,
        [this](RadioFrame::UniquePtr f) {inbox_.push_back(std::move(f));});
    odom_sub_ = create_subscription<nav_msgs::msg::Odometry>("odom", rclcpp::SensorDataQoS(),
        [this](nav_msgs::msg::Odometry::ConstSharedPtr m) {on_odom(*m);});
    battery_sub_ = create_subscription<sensor_msgs::msg::BatteryState>("battery", rclcpp::QoS(5),
        [this](sensor_msgs::msg::BatteryState::ConstSharedPtr m) {
          soc_ = m->percentage;
          have_battery_ = true;
        });
    safety_sub_ = create_subscription<SafetyStatus>("safety/status", rclcpp::QoS(10),
        [this](SafetyStatus::ConstSharedPtr m) {safety_ = *m; have_safety_ = true;});
    airspace_sub_ = create_subscription<aeropact_interfaces::msg::AirspaceRestrictionArray>(
      "/airspace/restrictions", rclcpp::QoS(1).transient_local().reliable(),
      [this](aeropact_interfaces::msg::AirspaceRestrictionArray::ConstSharedPtr m) {
        on_airspace(*m);
      });
    status_pub_ = create_publisher<aeropact_interfaces::msg::CoordinatorStatus>(
      "status", rclcpp::QoS(5));
    event_pub_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    payload_pub_ = create_publisher<aeropact_interfaces::msg::PayloadEvent>(
      "/sim/payload", rclcpp::QoS(50).reliable());
    if (mode_ == AllocationMode::kCentral) {
      hub_sub_ = create_subscription<aeropact_interfaces::msg::AssignmentArray>(
        "/hub/assignments", rclcpp::QoS(10).reliable(),
        [this](aeropact_interfaces::msg::AssignmentArray::ConstSharedPtr m) {on_hub(*m);});
      hub_uplink_ = create_publisher<aeropact_interfaces::msg::DroneState>(
        "/hub/telemetry", rclcpp::QoS(50));
      hub_task_pub_ = create_publisher<aeropact_interfaces::msg::TaskRecord>(
        "/hub/task_updates", rclcpp::QoS(100).reliable());
    }
    fly_client_ = rclcpp_action::create_client<FlyRoute>(this, "flight/fly_route");
    for (const auto & d : depot_ids_) {
      pickup_clients_[d] = create_client<aeropact_interfaces::srv::RequestPickup>(
        "/depots/" + d + "/request_pickup");
      bay_clients_[d] = create_client<aeropact_interfaces::srv::ReserveBay>(
        "/depots/" + d + "/reserve_bay");
    }
    fault_srv_ = create_service<aeropact_interfaces::srv::InjectFault>("~/inject_fault",
        [this](const std::shared_ptr<aeropact_interfaces::srv::InjectFault::Request> req,
        std::shared_ptr<aeropact_interfaces::srv::InjectFault::Response> res) {
          on_fault(*req, *res);
        });
    param_cb_ = add_on_set_parameters_callback(
      [this](const std::vector<rclcpp::Parameter> & params) {
        rcl_interfaces::msg::SetParametersResult r;
        r.successful = true;
        for (const auto & p : params) {
          if (p.get_name() == "clock_drift_ppm") {
            clock_.set_drift_ppm(p.as_double(), now().seconds());
          }
        }
        return r;
      });
    RCLCPP_INFO(get_logger(), "%s configured: mode=%s policy=%s layer=%.0f m world=%s",
      id_.c_str(), get_parameter("allocation_mode").as_string().c_str(),
      core::to_string(policy_kind_), cruise_alt_, world_->name.c_str());
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    radio_tx_->on_activate();
    status_pub_->on_activate();
    event_pub_->on_activate();
    payload_pub_->on_activate();
    if (hub_uplink_) {
      hub_uplink_->on_activate();
      hub_task_pub_->on_activate();
    }
    const double hz = get_parameter("tick_hz").as_double();
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(1.0 / hz),
        [this]() {tick();});
    active_ = true;
    emit("AGENT_STARTED", core::Json().add("mode", get_parameter("allocation_mode").as_string())
      .add("policy", core::to_string(policy_kind_)).add("layer_m", cruise_alt_));
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    // A deactivated coordinator is a dead companion computer: it stops talking at once.
    emit("AGENT_STOPPED", core::Json().add("activity", core::to_string(activity_)));
    active_ = false;
    if (timer_) {
      timer_->cancel();
    }
    radio_tx_->on_deactivate();
    status_pub_->on_deactivate();
    event_pub_->on_deactivate();
    payload_pub_->on_deactivate();
    if (hub_uplink_) {
      hub_uplink_->on_deactivate();
      hub_task_pub_->on_deactivate();
    }
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    radio_rx_.reset();
    odom_sub_.reset();
    battery_sub_.reset();
    safety_sub_.reset();
    airspace_sub_.reset();
    hub_sub_.reset();
    pickup_clients_.clear();
    inbox_.clear();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  // ---------------------------------------------------------------- inputs

  void on_odom(const nav_msgs::msg::Odometry & m)
  {
    pos_ = {m.pose.pose.position.x, m.pose.pose.position.y, m.pose.pose.position.z};
    const auto & q = m.pose.pose.orientation;
    const double yaw = std::atan2(2.0 * (q.w * q.z + q.x * q.y),
        1.0 - 2.0 * (q.y * q.y + q.z * q.z));
    const auto & l = m.twist.twist.linear;
    vel_ = {std::cos(yaw) * l.x - std::sin(yaw) * l.y, std::sin(yaw) * l.x + std::cos(yaw) * l.y,
      l.z};
    have_odom_ = true;
  }

  void on_airspace(const aeropact_interfaces::msg::AirspaceRestrictionArray & m)
  {
    for (const auto & r : m.restrictions) {
      core::NoFlyZone z;
      z.id = r.id;
      for (const auto & p : r.polygon) {
        z.polygon.push_back({p.x, p.y});
      }
      z.floor_m = r.floor_m;
      z.ceiling_m = r.ceiling_m > 0.0 ? r.ceiling_m : 1e9;
      z.active = r.active;
      z.reason = r.reason;
      if (world_->set_restriction(z)) {
        replan_pending_ = true;
        emit("AIRSPACE_UPDATE", core::Json().add("zone", z.id).add("active", z.active));
      }
    }
  }

  void on_fault(
    const aeropact_interfaces::srv::InjectFault::Request & req,
    aeropact_interfaces::srv::InjectFault::Response & res)
  {
    res.success = true;
    if (req.type == "clock_drift") {
      // args: {"ppm": <value>}
      const auto pos = req.args.find("ppm");
      double ppm = 0.0;
      if (pos != std::string::npos) {
        ppm = std::atof(req.args.c_str() + req.args.find(':', pos) + 1);
      }
      clock_.set_drift_ppm(ppm, now().seconds());
      res.message = "clock drift set";
    } else if (req.type == "distress") {
      send_distress("injected");
      res.message = "distress sent";
    } else if (req.type == "radio_silence") {
      radio_silent_ = req.args.find("false") == std::string::npos;
      res.message = radio_silent_ ? "radio silenced" : "radio restored";
    } else {
      res.success = false;
      res.message = "unknown fault type " + req.type;
    }
    emit("FAULT_APPLIED", core::Json().add("type", req.type).add("ok", res.success));
  }

  void on_hub(const aeropact_interfaces::msg::AssignmentArray & m)
  {
    hub_last_seen_ = now().seconds();
    for (const auto & a : m.assignments) {
      if (a.drone_id != id_) {
        continue;
      }
      core::Task t = from_msg(a.task);
      if (std::find(bundle_.begin(), bundle_.end(), t.task_id) != bundle_.end()) {
        continue;
      }
      const core::Task * cur = replica_.task(t.task_id);
      if (cur != nullptr && !core::is_pre_pickup(cur->state)) {
        continue;
      }
      if (cur != nullptr && cur->claim_epoch > t.claim_epoch) {
        // Stale assignment: tell the hub what we know instead of adopting it.
        hub_task_pub_->publish(to_msg(*cur));
        continue;
      }
      // Decline work this vehicle cannot fly under its calibrated energy model.
      core::BidderState me;
      me.id = id_;
      me.position = pos_;
      me.soc = soc_;
      me.capacity_kg = get_parameter("capacity_kg").as_double();
      me.fleet_now = fleet_now_;
      double score = 0.0;
      if (!auction_->score_insertion(me, {}, t, 0, {}, score) ||
        soc_ < get_parameter("min_takeoff_soc").as_double() || energy_divert_)
      {
        core::Task back = core::OwnershipManager::reopen(t);
        write_task(back);
        hub_task_pub_->publish(to_msg(back));
        emit("HUB_ASSIGNMENT_DECLINED", core::Json().add("task_id", t.task_id).add("soc", soc_));
        continue;
      }
      t.state = TaskState::kCommitted;
      t.owner = id_;
      write_task(t);
      own_->adopt(t, local_now_);
      bundle_.push_back(t.task_id);
      emit("HUB_ASSIGNMENT", core::Json().add("task_id", t.task_id).add("epoch", t.claim_epoch));
    }
  }

  // ---------------------------------------------------------------- tick

  void tick()
  {
    if (!active_ || !have_odom_) {
      return;
    }
    fleet_now_ = now().seconds();
    local_now_ = clock_.now(fleet_now_);

    process_inbox();
    update_membership();
    ownership_step();
    if (use_shard_leases_) {
      shard_step();
    }
    allocation_step();
    mission_step();
    radio_step();
    if (fleet_now_ - last_status_ >= 1.0) {
      last_status_ = fleet_now_;
      publish_status();
    }
    if (local_now_ - last_prune_ >= 30.0) {
      last_prune_ = local_now_;
      replica_.prune(local_now_);
    }
  }

  // ---------------------------------------------------------------- radio in

  void process_inbox()
  {
    while (!inbox_.empty()) {
      RadioFrame::UniquePtr f = std::move(inbox_.front());
      inbox_.pop_front();
      if (radio_silent_ || f->version > RadioFrame::VERSION || f->src == id_) {
        continue;  // newer major versions are ignored (NFR-3)
      }
      if (f->dst != "*" && f->dst != id_) {
        continue;
      }
      ++frames_rx_;
      switch (f->type) {
        case RadioFrame::TYPE_GOSSIP_DELTA:
          if (!f->gossip.empty()) {
            on_gossip(f->src, f->gossip.front());
          }
          break;
        case RadioFrame::TYPE_HEARTBEAT:
          if (!f->heartbeat.empty()) {
            on_heartbeat(f->heartbeat.front());
          }
          break;
        case RadioFrame::TYPE_PROBE:
          if (!f->probe.empty()) {
            on_probe(f->probe.front());
          }
          break;
        case RadioFrame::TYPE_PROBE_ACK:
          if (!f->probe_ack.empty()) {
            const auto & a = f->probe_ack.front();
            fd_->probe_ack(a.target, a.heard_recently, a.last_heard_age_s, local_now_);
          }
          break;
        case RadioFrame::TYPE_DISTRESS:
          if (!f->distress.empty()) {
            fd_->distress(f->distress.front().drone_id, local_now_);
          }
          break;
        case RadioFrame::TYPE_SUSPICION:
          if (!f->suspicion.empty()) {
            const auto & s = f->suspicion.front();
            if (s.level == aeropact_interfaces::msg::Suspicion::LEVEL_UNREACHABLE) {
              fd_->vote_unreachable(s.observer, s.target, s.physical_evidence, local_now_);
            }
          }
          break;
        case RadioFrame::TYPE_PAD_RESPONSE:
          if (!f->pad_response.empty()) {
            on_pad_response(f->pad_response.front());
          }
          break;
        default:
          break;  // unknown or not for drones: ignored
      }
    }
  }

  void on_gossip(const std::string & src, const aeropact_interfaces::msg::GossipDelta & m)
  {
    const core::Delta delta = from_msg(m);
    const core::MergeResult r = replica_.apply(delta, local_now_);
    for (const auto & tr : r.tasks) {
      const core::Task & t = tr.after;
      const bool leased = t.state == TaskState::kClaimed || t.state == TaskState::kCommitted;
      if (leased && !t.owner.empty() && t.owner != id_) {
        auto & a = ack_tasks_[t.task_id];
        a = std::max(a, std::make_pair(t.claim_epoch, t.lease_seq));
      }
      if (t.priority == 1 && t.state == TaskState::kUnassigned) {
        urgent_ = true;  // REQ-AUC-003: event-driven re-auction
      }
      if (!tr.before) {
        hlc_seen_ = std::max(hlc_seen_, t.created_at);
      }
    }
    for (const auto & l : r.shard_changes) {
      if (l.holder != id_) {
        auto & a = ack_shards_[l.shard_id];
        a = std::max(a, std::make_pair(l.epoch, l.lease_seq));
      }
    }
    (void)src;
  }

  void on_heartbeat(const aeropact_interfaces::msg::Heartbeat & hb)
  {
    core::PeerObservation obs;
    obs.position = from_msg(hb.position);
    obs.soc = hb.soc;
    obs.health = static_cast<core::Health>(std::min<uint8_t>(hb.health, 2));
    obs.max_endurance_s = hb.max_endurance_s;
    obs.is_depot = hb.is_depot;
    if (const core::DroneInfo * d = replica_.drone(hb.node_id)) {
      obs.vertical_speed = d->velocity.z;
    }
    fd_->heartbeat(hb.node_id, local_now_, obs);
    const std::size_t n = std::min({hb.ack_task_ids.size(), hb.ack_epochs.size(),
          hb.ack_lease_seqs.size()});
    for (std::size_t i = 0; i < n; ++i) {
      own_->on_ack(hb.node_id, hb.ack_task_ids[i], hb.ack_epochs[i], hb.ack_lease_seqs[i]);
    }
    const std::size_t ns = std::min({hb.ack_shard_ids.size(), hb.ack_shard_epochs.size(),
          hb.ack_shard_lease_seqs.size()});
    for (std::size_t i = 0; i < ns; ++i) {
      auto it = my_shards_.find(hb.ack_shard_ids[i]);
      if (it != my_shards_.end() && it->second.epoch == hb.ack_shard_epochs[i]) {
        for (auto & [seq, t] : it->second.sent_at) {
          if (seq <= hb.ack_shard_lease_seqs[i]) {
            it->second.ackers[seq].insert(hb.node_id);
          }
        }
      }
    }
  }

  void on_probe(const aeropact_interfaces::msg::Probe & p)
  {
    if (p.requester == id_) {
      return;
    }
    RadioFrame f = frame(RadioFrame::TYPE_PROBE_ACK, p.requester);
    aeropact_interfaces::msg::ProbeAck a;
    a.responder = id_;
    a.requester = p.requester;
    a.target = p.target;
    a.nonce = p.nonce;
    a.last_heard_age_s = fd_->last_heard_age(p.target, local_now_);
    a.heard_recently = a.last_heard_age_s < 3.0;
    f.probe_ack.push_back(a);
    send(std::move(f));
  }

  // ---------------------------------------------------------------- membership

  void update_membership()
  {
    std::vector<core::ProbeRequest> probes;
    const auto transitions = fd_->update(local_now_, probes, view_.has_majority());
    for (const auto & tr : transitions) {
      emit("PEER_STATE", core::Json().add("peer", tr.id).add("from", core::to_string(tr.from))
        .add("to", core::to_string(tr.to)).add("reason", tr.reason));
      if (tr.to == core::PeerState::kUnreachable) {
        broadcast_suspicion(tr.id);
      }
      if (tr.to == core::PeerState::kDeclaredFailed) {
        on_declared_failed(tr.id, tr.reason);
      }
    }
    for (const auto & p : probes) {
      RadioFrame f = frame(RadioFrame::TYPE_PROBE, p.via);
      aeropact_interfaces::msg::Probe pr;
      pr.requester = id_;
      pr.target = p.target;
      pr.nonce = ++probe_nonce_;
      f.probe.push_back(pr);
      send(std::move(f));
    }

    view_ = core::MembershipView{};
    view_.self = id_;
    for (const auto & r : roster_) {
      if (fd_->state(r) != core::PeerState::kDeclaredFailed) {
        view_.known.insert(r);
      }
    }
    for (const auto & d : depot_ids_) {
      view_.known.insert(d);
    }
    view_.known.insert(id_);
    for (const auto & r : fd_->reachable()) {
      if (view_.known.count(r) != 0U) {
        view_.reachable.insert(r);
      }
    }
    view_.shard_holders = valid_shard_holders();

    core::LinkMode mode = core::LinkMode::kSolo;
    if (view_.reachable.size() == view_.known.size()) {
      mode = core::LinkMode::kConnected;
    } else if (view_.has_majority()) {
      mode = core::LinkMode::kDegraded;
    } else if (view_.reachable.size() > 1) {
      mode = core::LinkMode::kPartitioned;
    }
    if (mode != link_mode_) {
      emit("MODE_CHANGE", core::Json().add("from", core::to_string(link_mode_))
        .add("to", core::to_string(mode)).add("reachable", view_.reachable.size())
        .add("known", view_.known.size()));
      link_mode_ = mode;
    }
  }

  void on_declared_failed(const std::string & peer, const std::string & reason)
  {
    emit("DECLARED_FAILED", core::Json().add("peer", peer).add("reason", reason));
    // REQ-FAIL-004: only now is the failed drone's in-flight parcel re-ordered.
    for (const auto & [tid, e] : replica_.tasks()) {
      const core::Task & t = e.task;
      if (t.owner != peer) {
        continue;
      }
      if (t.state == TaskState::kPickedUp) {
        core::Task a = t;
        a.state = TaskState::kAborted;
        a.abort_reason = "lost_in_flight";
        write_task(a);
        emit("TASK_ABORTED", core::Json().add("task_id", tid).add("owner", peer)
          .add("reason", "lost_in_flight"));
      } else if (t.state == TaskState::kClaimed || t.state == TaskState::kCommitted) {
        write_task(core::OwnershipManager::reopen(t));
        emit("RELEASE", core::Json().add("task_id", tid).add("owner", peer)
          .add("reason", "owner_failed"));
      }
    }
  }

  void broadcast_suspicion(const std::string & target)
  {
    RadioFrame f = frame(RadioFrame::TYPE_SUSPICION, "*");
    aeropact_interfaces::msg::Suspicion s;
    s.observer = id_;
    s.target = target;
    s.level = aeropact_interfaces::msg::Suspicion::LEVEL_UNREACHABLE;
    s.last_heard_age_s = fd_->last_heard_age(target, local_now_);
    const auto & peers = fd_->peers();
    auto it = peers.find(target);
    if (it != peers.end()) {
      s.last_position = to_point(it->second.last.position);
      s.last_soc = static_cast<float>(it->second.last.soc);
      s.physical_evidence = it->second.evidence;
    }
    f.suspicion.push_back(s);
    send(std::move(f));
  }

  void send_distress(const std::string & reason)
  {
    RadioFrame f = frame(RadioFrame::TYPE_DISTRESS, "*");
    aeropact_interfaces::msg::Distress d;
    d.drone_id = id_;
    d.reason = reason;
    d.position = to_point(pos_);
    d.carrying_task_id = carrying_ ? active_task_ : "";
    f.distress.push_back(d);
    send(std::move(f));
    emit("DISTRESS", core::Json().add("reason", reason).add("task_id", d.carrying_task_id));
  }

  // ---------------------------------------------------------------- ownership

  void ownership_step()
  {
    own_->evaluate(replica_, view_, *policy_);

    // Lost tasks: outbid, re-opened, or taken over after our lease lapsed elsewhere.
    for (const auto & tid : own_->lost(replica_)) {
      if (mode_ == AllocationMode::kGreedyNearest) {
        continue;  // baseline without an ownership protocol: keeps flying regardless
      }
      const core::Task * cur = replica_.task(tid);
      const bool carrying_this = carrying_ && tid == active_task_;
      if (carrying_this) {
        // Both past pickup (only possible without depot arbitration): the merge winner keeps
        // the delivery, we divert the parcel back to its depot (03 3.5(g)).
        emit("DUPLICATE_RESOLVED", core::Json().add("task_id", tid)
          .add("winner", cur != nullptr ? cur->owner : "").add("action", "return_to_depot"));
        own_->forget(tid);
        remove_from_bundle(tid);
        divert_parcel_ = true;
        continue;
      }
      emit("TASK_LOST", core::Json().add("task_id", tid)
        .add("new_owner", cur != nullptr ? cur->owner : "")
        .add("state", cur != nullptr ? core::to_string(cur->state) : ""));
      bundle_repair(tid);
    }

    // Zombie-stop (I3): stop acting on any pre-pickup task whose own lease lapsed.
    for (const auto & tid : own_->lapsed(local_now_)) {
      const core::OwnershipManager::HeldLease * h = own_->held(tid);
      if (h == nullptr || h->sticky) {
        continue;
      }
      emit("LEASE_LAPSED", core::Json().add("task_id", tid).add("epoch", h->claim_epoch)
        .add("local", local_now_));
      const bool active = tid == active_task_;
      own_->forget(tid);
      remove_from_bundle(tid);
      if (active) {
        abort_active("lease_lapsed");
      }
    }

    reconcile_replacements();

    for (const auto & r : own_->due_renewals(replica_, local_now_)) {
      write_task(r);
    }
    for (const auto & c : own_->commit_ready(replica_, local_now_)) {
      write_task(c);
      emit("COMMIT", core::Json().add("task_id", c.task_id).add("epoch", c.claim_epoch)
        .add("bid", c.bid));
    }
    if (mode_ == AllocationMode::kPact) {
      for (const auto & r : own_->foreign_expired(replica_, local_now_)) {
        // Re-opening is a new claim opportunity: only where the policy lets us claim.
        if (!policy_->may_claim_new(r, view_, own_->optimistic_in_flight())) {
          continue;
        }
        const core::Task * prev = replica_.task(r.task_id);
        emit("LEASE_EXPIRED_REOPEN", core::Json().add("task_id", r.task_id)
          .add("prev_owner", prev != nullptr ? prev->owner : "").add("epoch", r.claim_epoch));
        write_task(r);
      }
    }
  }

  /// Lost-in-flight parcels that turn out not to be lost (the "failed" carrier was only
  /// partitioned away). A replacement whose original was delivered is cancelled; a carrier whose
  /// parcel was written off keeps delivering unless the replacement is already in flight, in which
  /// case it returns the parcel to its depot (03 3.5(g)).
  void reconcile_replacements()
  {
    std::vector<core::Task> cancels;
    for (const auto & [tid, e] : replica_.tasks()) {
      const core::Task & t = e.task;
      if (t.replaces.empty() || !core::is_pre_pickup(t.state)) {
        continue;
      }
      const core::Task * original = replica_.task(t.replaces);
      if (original != nullptr && original->state == TaskState::kDelivered) {
        core::Task c = t;
        c.state = TaskState::kAborted;
        c.abort_reason = "original_delivered";
        cancels.push_back(c);
      }
    }
    for (const auto & c : cancels) {
      write_task(c);
      emit("REPLACEMENT_CANCELLED", core::Json().add("task_id", c.task_id)
        .add("original", c.replaces));
      if (own_->holds(c.task_id) && !(carrying_ && active_task_ == c.task_id)) {
        own_->forget(c.task_id);
        bundle_repair(c.task_id);
      }
    }
    if (!carrying_ || active_task_.empty() || divert_parcel_) {
      return;
    }
    const core::Task * mine = replica_.task(active_task_);
    if (mine == nullptr || mine->state != TaskState::kAborted ||
      mine->abort_reason != "lost_in_flight")
    {
      return;
    }
    const core::Task * repl = replica_.task(active_task_ + "-R");
    if (repl != nullptr && !core::is_pre_pickup(repl->state) &&
      repl->state != TaskState::kAborted)
    {
      emit("DUPLICATE_RESOLVED", core::Json().add("task_id", active_task_)
        .add("winner", repl->task_id).add("action", "return_to_depot"));
      own_->forget(active_task_);
      remove_from_bundle(active_task_);
      divert_parcel_ = true;
    } else if (!reported_written_off_) {
      reported_written_off_ = true;
      emit("WRITTEN_OFF_BUT_ALIVE", core::Json().add("task_id", active_task_)
        .add("replacement", repl != nullptr ? repl->task_id : ""));
    }
  }

  /// CBBA bundle repair: losing a task invalidates the tasks queued after it.
  void bundle_repair(const std::string & lost_id)
  {
    auto it = std::find(bundle_.begin(), bundle_.end(), lost_id);
    if (it == bundle_.end()) {
      own_->forget(lost_id);
      return;
    }
    std::vector<std::string> after(it + 1, bundle_.end());
    bundle_.erase(it, bundle_.end());
    own_->forget(lost_id);
    if (lost_id == active_task_) {
      abort_active("task_lost");
    }
    for (const auto & tid : after) {
      release_task(tid, "bundle_repair");
    }
  }

  void release_task(const std::string & tid, const std::string & reason)
  {
    const core::Task * cur = replica_.task(tid);
    if (cur != nullptr && cur->owner == id_ && core::is_pre_pickup(cur->state)) {
      write_task(core::OwnershipManager::reopen(*cur));
      emit("RELEASE", core::Json().add("task_id", tid).add("reason", reason));
    }
    own_->forget(tid);
    remove_from_bundle(tid);
    if (tid == active_task_) {
      abort_active(reason);
    }
  }

  void remove_from_bundle(const std::string & tid)
  {
    bundle_.erase(std::remove(bundle_.begin(), bundle_.end(), tid), bundle_.end());
  }

  // ---------------------------------------------------------------- shard leases

  struct HeldShard
  {
    std::uint32_t epoch{0};
    std::uint32_t seq{0};
    double valid_from{0.0};
    double last_send{0.0};
    std::map<std::uint32_t, double> sent_at;
    std::map<std::uint32_t, std::set<std::string>> ackers;
  };

  std::map<std::string, std::string> valid_shard_holders()
  {
    std::map<std::string, std::string> out;
    if (!use_shard_leases_) {
      return out;
    }
    const double observer_timeout = shard_ttl_ * (1.0 + own_->config().drift_margin) +
      own_->config().grace;
    for (const auto & [sid, l] : replica_.shard_leases()) {
      if (l.holder == id_) {
        auto it = my_shards_.find(sid);
        if (it != my_shards_.end() && it->second.epoch == l.epoch &&
          local_now_ < it->second.valid_from + shard_ttl_)
        {
          out[sid] = id_;
        }
        continue;
      }
      auto & obs = shard_observed_[sid];
      const auto ident = std::make_tuple(l.epoch, l.lease_seq, l.holder);
      if (obs.first != ident) {
        obs = {ident, local_now_};
      }
      if (local_now_ - obs.second < observer_timeout &&
        fd_->state(l.holder) != core::PeerState::kDeclaredFailed)
      {
        out[sid] = l.holder;
      }
    }
    return out;
  }

  void shard_step()
  {
    // Confirm, renew or drop the shard leases we hold.
    for (auto it = my_shards_.begin(); it != my_shards_.end(); ) {
      HeldShard & h = it->second;
      const core::ShardLease * cur = replica_.shard_lease(it->first);
      if (cur == nullptr || cur->holder != id_ || cur->epoch != h.epoch) {
        it = my_shards_.erase(it);
        continue;
      }
      for (auto s = h.sent_at.rbegin(); s != h.sent_at.rend(); ++s) {
        static const std::set<std::string> kNone;
        auto a = h.ackers.find(s->first);
        if (core::quorum_confirmed(a == h.ackers.end() ? kNone : a->second, view_)) {
          h.valid_from = std::max(h.valid_from, s->second);
          break;
        }
      }
      if (local_now_ >= h.valid_from + shard_ttl_) {
        emit("SHARD_LEASE_LAPSED", core::Json().add("shard", it->first).add("epoch", h.epoch));
        it = my_shards_.erase(it);
        continue;
      }
      if (local_now_ - h.last_send >= own_->config().renew_period) {
        core::ShardLease l = *cur;
        l.lease_seq = ++h.seq;
        h.last_send = local_now_;
        h.sent_at[l.lease_seq] = local_now_;
        while (h.sent_at.size() > 8) {
          h.ackers.erase(h.sent_at.begin()->first);
          h.sent_at.erase(h.sent_at.begin());
        }
        replica_.upsert_shard_lease(l);
      }
      ++it;
    }

    // Acquire leases for shards with open work and no valid holder. Only with a majority, and
    // only the lowest-id reachable drone acquires, so concurrent acquisitions are rare (and
    // resolved by the lease order when they happen).
    if (local_now_ - last_shard_scan_ < 2.0 || !view_.has_majority()) {
      return;
    }
    last_shard_scan_ = local_now_;
    std::string designated = id_;
    for (const auto & r : view_.reachable) {
      if (std::find(roster_.begin(), roster_.end(), r) != roster_.end() && r < designated) {
        designated = r;
      }
    }
    if (designated != id_) {
      return;
    }
    std::set<std::string> wanted;
    for (const auto & [tid, e] : replica_.tasks()) {
      if (e.task.state == TaskState::kUnassigned && !e.task.shard.empty()) {
        wanted.insert(e.task.shard);
      }
    }
    for (const auto & sid : wanted) {
      if (view_.shard_holders.count(sid) != 0U) {
        continue;
      }
      const core::ShardLease * cur = replica_.shard_lease(sid);
      core::ShardLease l{sid, id_, cur != nullptr ? cur->epoch + 1 : 1U, 0U, shard_ttl_};
      if (replica_.upsert_shard_lease(l)) {
        HeldShard h;
        h.epoch = l.epoch;
        h.valid_from = local_now_;
        h.last_send = local_now_;
        h.sent_at[0] = local_now_;
        my_shards_[sid] = h;
        emit("SHARD_LEASE_ACQUIRED", core::Json().add("shard", sid).add("epoch", l.epoch));
      }
    }
  }

  // ---------------------------------------------------------------- allocation

  bool can_take_work() const
  {
    if (health_ != core::Health::kOk || activity_ == Activity::kSafetyOverride ||
      activity_ == Activity::kLanded || divert_parcel_ || energy_divert_)
    {
      return false;
    }
    if (!have_battery_ || soc_ < get_parameter("min_takeoff_soc").as_double()) {
      return false;
    }
    return true;
  }

  void allocation_step()
  {
    if (mode_ == AllocationMode::kCentral) {
      return;  // the hub assigns
    }
    const double period = get_parameter("auction_period_s").as_double();
    const bool due = local_now_ - last_auction_ >= period;
    if (!(due || urgent_) || !can_take_work()) {
      return;
    }
    last_auction_ = local_now_;
    urgent_ = false;

    std::vector<core::Task> candidates;
    const std::size_t optimistic = own_->optimistic_in_flight();
    for (const auto & [tid, e] : replica_.tasks()) {
      const core::Task & t = e.task;
      if (own_->holds(tid) || std::find(bundle_.begin(), bundle_.end(), tid) != bundle_.end()) {
        continue;
      }
      const bool open = t.state == TaskState::kUnassigned;
      const bool contestable = t.state == TaskState::kClaimed && t.owner != id_ &&
        mode_ != AllocationMode::kGreedyNearest;
      if (!open && !contestable) {
        continue;
      }
      if (mode_ == AllocationMode::kPact && !policy_->may_claim_new(t, view_, optimistic)) {
        continue;
      }
      if (world_->depot(t.origin_depot) == nullptr) {
        continue;
      }
      if (!t.replaces.empty()) {
        const core::Task * original = replica_.task(t.replaces);
        if (original != nullptr && original->state == TaskState::kDelivered) {
          continue;  // the original arrived after all; the replacement is being cancelled
        }
      }
      candidates.push_back(t);
    }
    if (candidates.empty()) {
      return;
    }

    core::BidderState me;
    me.id = id_;
    me.position = pos_;
    me.soc = soc_;
    me.capacity_kg = get_parameter("capacity_kg").as_double();
    me.fleet_now = fleet_now_;
    for (const auto & tid : bundle_) {
      if (const core::Task * t = replica_.task(tid)) {
        me.bundle.push_back(*t);
      }
    }

    if (mode_ == AllocationMode::kGreedyNearest) {
      if (!bundle_.empty()) {
        return;
      }
      const core::Task * best = nullptr;
      double best_d = 1e18;
      for (const auto & c : candidates) {
        double s = 0.0;
        if (!auction_->score_insertion(me, {}, c, 0, {}, s)) {
          continue;
        }
        const double d = geom::dist_xy(pos_, c.pickup) + geom::dist_xy(c.pickup, c.drop);
        if (d < best_d) {
          best_d = d;
          best = &c;
        }
      }
      if (best != nullptr) {
        claim(*best, -best_d, false, bundle_.size());
      }
      return;
    }

    const auto bids = auction_->build_bundle(me, candidates, replica_.pad_reservations());
    for (const auto & b : bids) {
      const bool optimistic_claim = mode_ == AllocationMode::kPact &&
        policy_->is_optimistic_claim(b.task, view_);
      claim(b.task, b.score, optimistic_claim, b.position);
    }
  }

  /// Claim `current` and insert it at `position` in the bundle (the auction's best insertion
  /// point; the bundle head is the task being flown and never moves).
  void claim(const core::Task & current, double bid, bool optimistic, std::size_t position)
  {
    core::Task c = own_->claim(current, bid, local_now_, optimistic);
    if (mode_ != AllocationMode::kPact) {
      c.state = TaskState::kCommitted;  // baselines commit immediately (no leases)
    }
    write_task(c);
    const std::size_t pos = std::clamp<std::size_t>(position, bundle_.empty() ? 0 : 1,
        bundle_.size());
    bundle_.insert(bundle_.begin() + static_cast<std::ptrdiff_t>(pos), c.task_id);
    emit("CLAIM", core::Json().add("task_id", c.task_id).add("epoch", c.claim_epoch)
      .add("bid", bid).add("optimistic", optimistic)
      .add("outbid", current.state == TaskState::kClaimed ? current.owner : ""));
  }

  // ---------------------------------------------------------------- mission

  /// Next task that may be flown now: held, committed, lease valid.
  std::optional<std::string> next_ready_task() const
  {
    for (const auto & tid : bundle_) {
      const core::Task * t = replica_.task(tid);
      if (t == nullptr || t->owner != id_) {
        continue;
      }
      if (t->state == TaskState::kCommitted && own_->lease_valid(tid, local_now_)) {
        return tid;
      }
      return std::nullopt;  // keep bundle order: wait for the head to commit
    }
    return std::nullopt;
  }

  /// Learn how the real battery compares with the model (observed / predicted SOC use), so every
  /// later estimate (bids, feasibility, endurance advertised to peers) reflects this vehicle.
  void calibrate_energy()
  {
    if (!have_battery_ || !have_odom_) {
      return;
    }
    const bool airborne = pos_.z > 1.0;
    if (calib_t_ >= 0.0 && airborne) {
      const double dt = fleet_now_ - calib_t_;
      const Vec3 air{vel_.x - world_->wind.x, vel_.y - world_->wind.y, 0.0};
      const double payload = carrying_ ? payload_kg_ : 0.0;
      calib_pred_ += energy_->power_w(geom::norm_xy(air), payload) * dt /
        (energy_->params().battery_wh * 3600.0);
    }
    calib_t_ = fleet_now_;
    if (!airborne) {
      calib_pred_ = 0.0;
      calib_soc_ = soc_;
      return;
    }
    if (calib_soc_ < 0.0) {
      calib_soc_ = soc_;
    }
    const double used = calib_soc_ - soc_;
    if (calib_pred_ > 0.01 && used > 0.0) {
      const double ratio = std::clamp(used / calib_pred_, 0.5, 8.0);
      const double f = 0.5 * energy_->params().consumption_factor + 0.5 * ratio;
      if (std::abs(f - energy_->params().consumption_factor) > 0.1) {
        emit("ENERGY_CALIBRATION", core::Json().add("factor", f).add("observed", used)
          .add("modelled", calib_pred_));
      }
      energy_->set_consumption_factor(f);
      calib_pred_ = 0.0;
      calib_soc_ = soc_;
    }
  }

  /// Mission-level energy contingency: divert to the nearest pad while that is still feasible,
  /// so the safety supervisor's battery failsafe is a last resort, not the plan.
  bool energy_divert_needed() const
  {
    if (!have_battery_ || pos_.z < 1.0 || activity_ == Activity::kToPad ||
      activity_ == Activity::kCharging || energy_divert_)
    {
      return false;
    }
    const core::Pad * pad = world_->nearest_pad(pos_);
    if (pad == nullptr) {
      return false;
    }
    const double need = energy_->pessimistic(energy_->soc_for_leg(pos_, pad->position,
        carrying_ ? payload_kg_ : 0.0, world_->wind, cruise_alt_, true));
    return soc_ - energy_->params().soc_sigma - need < 0.12;
  }

  void divert_for_energy()
  {
    energy_divert_ = true;
    const core::Pad * pad = world_->nearest_pad(pos_);
    emit("ENERGY_DIVERT", core::Json().add("soc", soc_).add("pad", pad->id)
      .add("factor", energy_->params().consumption_factor).add("carrying", carrying_));
    const std::vector<std::string> held = bundle_;
    for (const auto & tid : held) {
      if (carrying_ && tid == active_task_) {
        continue;
      }
      release_task(tid, "energy_divert");
    }
    if (carrying_) {
      if (const core::Task * t = replica_.task(active_task_)) {
        core::Task ab = *t;
        ab.state = TaskState::kAborted;
        ab.abort_reason = "energy_divert";
        write_task(ab);
        emit("TASK_ABORTED",
            core::Json().add("task_id", ab.task_id).add("reason", "energy_divert"));
      }
      own_->forget(active_task_);
      remove_from_bundle(active_task_);
      carrying_ = false;
    }
    active_task_.clear();
    cancel_goal();
    pad_id_ = pad->id;
    pad_pos_ = pad->position;
    pad_granted_ = true;
    if (start_leg(pad_pos_, LegEnd::kLand, "to_pad")) {
      activity_ = Activity::kToPad;
    }
  }

  void mission_step()
  {
    handle_safety();
    calibrate_energy();
    if (energy_divert_ && activity_ == Activity::kCharging &&
      soc_ >= get_parameter("min_takeoff_soc").as_double())
    {
      energy_divert_ = false;
    }
    if (activity_ != Activity::kSafetyOverride && activity_ != Activity::kLanded &&
      energy_divert_needed())
    {
      divert_for_energy();
      return;
    }
    if (activity_ == Activity::kSafetyOverride || activity_ == Activity::kLanded) {
      return;
    }
    if (replan_pending_ && goal_active_) {
      replan_pending_ = false;
      if (!leg_target_purpose_.empty()) {
        start_leg(leg_target_, leg_end_, leg_target_purpose_);  // re-route around new zones
      }
    }
    if (divert_parcel_ && !goal_active_ && activity_ != Activity::kToPad) {
      return_parcel();
      return;
    }
    switch (activity_) {
      case Activity::kIdle:
      case Activity::kCharging:
      case Activity::kHolding: {
          if (auto tid = next_ready_task()) {
            begin_task(*tid);
          } else if (bundle_.empty()) {
            park_if_needed();
          }
          break;
        }
      case Activity::kLoading:
        if (!goal_active_ && !bay_granted_) {
          request_bay();
        }
        [[fallthrough]];
      case Activity::kToPickup:
      case Activity::kToDrop:
        if (!active_task_.empty() && !carrying_ && !own_->lease_valid(active_task_, local_now_)) {
          // Already handled by the lapsed() pass; defensive double check before the hand-off.
          abort_active("lease_lapsed");
        }
        break;
      case Activity::kDropping:
        if (fleet_now_ >= drop_until_) {
          complete_delivery();
        }
        break;
      default:
        break;
    }
  }

  void handle_safety()
  {
    if (!have_safety_) {
      return;
    }
    const uint8_t a = safety_.action;
    const bool contingency = a == SafetyStatus::ACTION_RTL ||
      a == SafetyStatus::ACTION_LAND_NEAREST || a == SafetyStatus::ACTION_LAND_NOW;
    if (contingency && activity_ != Activity::kSafetyOverride &&
      activity_ != Activity::kLanded)
    {
      emit("SAFETY_OVERRIDE", core::Json().add("action", static_cast<int>(a))
        .add("reason", safety_.reason));
      cancel_goal();
      activity_ = Activity::kSafetyOverride;
      health_ = core::Health::kDegraded;
      // Pre-pickup work goes back to the fleet; a parcel on board is reported lost so the
      // depot can re-order it.
      const std::vector<std::string> held = bundle_;
      for (const auto & tid : held) {
        if (carrying_ && tid == active_task_) {
          continue;
        }
        release_task(tid, "safety_override");
      }
      if (carrying_) {
        if (const core::Task * t = replica_.task(active_task_)) {
          core::Task ab = *t;
          ab.state = TaskState::kAborted;
          ab.abort_reason = "safety_landing";
          write_task(ab);
          emit("TASK_ABORTED", core::Json().add("task_id", ab.task_id)
            .add("reason", "safety_landing"));
        }
        own_->forget(active_task_);
        remove_from_bundle(active_task_);
        carrying_ = false;
        active_task_.clear();
      }
    }
    if (activity_ == Activity::kSafetyOverride && !safety_.armed) {
      activity_ = Activity::kLanded;
      emit("LANDED_AFTER_CONTINGENCY", core::Json().add("x", pos_.x).add("y", pos_.y));
    }
  }

  void begin_task(const std::string & tid)
  {
    const core::Task * t = replica_.task(tid);
    const core::Depot * depot = t != nullptr ? world_->depot(t->origin_depot) : nullptr;
    if (t == nullptr || depot == nullptr) {
      release_task(tid, "unknown_depot");
      return;
    }
    leave_pad();
    active_task_ = tid;
    // Queue at this vehicle's own staging point beside the depot, on its cruise layer; descend
    // only to a bay the depot grants (no stacking over a shared hand-off point).
    if (!start_leg(staging_point(*depot), LegEnd::kHover, "to_pickup")) {
      release_task(tid, "no_route");
      return;
    }
    activity_ = Activity::kToPickup;
    emit("MISSION_START", core::Json().add("task_id", tid).add("depot", t->origin_depot));
  }

  void on_leg_done(const std::string & purpose, bool success, uint8_t code)
  {
    if (!success) {
      emit("LEG_FAILED", core::Json().add("purpose", purpose).add("code", static_cast<int>(code)));
      if (activity_ == Activity::kSafetyOverride || activity_ == Activity::kLanded) {
        return;
      }
      if ((purpose == "to_pickup" || purpose == "to_bay") && !active_task_.empty()) {
        release_task(active_task_, "leg_failed");
      }
      if (purpose == "to_drop") {
        // Keep the parcel and try again from where we are.
        start_leg(leg_target_, LegEnd::kHover, "to_drop");
        return;
      }
      activity_ = Activity::kHolding;
      pad_granted_ = false;
      return;
    }
    if (purpose == "to_pickup") {
      activity_ = Activity::kLoading;
      bay_retry_at_ = fleet_now_;
      bay_granted_ = false;
      bay_wait_since_ = -1.0;
    } else if (purpose == "to_bay") {
      request_pickup();
    } else if (purpose == "to_drop") {
      activity_ = Activity::kDropping;
      drop_until_ = fleet_now_ + get_parameter("drop_dwell_s").as_double();
    } else if (purpose == "to_pad") {
      activity_ = Activity::kCharging;
      emit("PARKED", core::Json().add("pad", pad_id_).add("soc", soc_));
    } else if (purpose == "return_parcel") {
      publish_payload(returned_task_, false);
      emit("PARCEL_RETURNED", core::Json().add("task_id", returned_task_));
      returned_task_.clear();
      divert_parcel_ = false;
      carrying_ = false;
      activity_ = Activity::kHolding;
    }
  }

  /// Holding point beside the depot, one per vehicle (by id), on the vehicle's cruise layer.
  Vec3 staging_point(const core::Depot & depot) const
  {
    int n = 0;
    for (const char c : id_) {
      if (std::isdigit(static_cast<unsigned char>(c))) {
        n = n * 10 + (c - '0');
      }
    }
    const double a = 2.0 * M_PI * static_cast<double>(n % 8) / 8.0;
    return {depot.handoff.x + 45.0 * std::cos(a), depot.handoff.y + 45.0 * std::sin(a),
      cruise_alt_};
  }

  /// While waiting at the staging point: ask the depot for a bay until one is granted.
  void request_bay()
  {
    if (bay_pending_ || bay_granted_ || fleet_now_ < bay_retry_at_) {
      return;
    }
    const core::Task * t = replica_.task(active_task_);
    if (t == nullptr) {
      abort_active("task_vanished");
      return;
    }
    auto it = bay_clients_.find(t->origin_depot);
    if (it == bay_clients_.end() || !it->second->service_is_ready()) {
      bay_retry_at_ = fleet_now_ + 3.0;
      if (fleet_now_ - bay_wait_since_ > 120.0) {
        release_task(active_task_, "depot_unavailable");
      }
      return;
    }
    if (bay_wait_since_ < 0.0) {
      bay_wait_since_ = fleet_now_;
    }
    bay_pending_ = true;
    auto req = std::make_shared<aeropact_interfaces::srv::ReserveBay::Request>();
    req->drone_id = id_;
    req->task_id = active_task_;
    const std::string tid = active_task_;
    it->second->async_send_request(req,
      [this, tid](rclcpp::Client<aeropact_interfaces::srv::ReserveBay>::SharedFuture f) {
        bay_pending_ = false;
        const auto & r = *f.get();
        if (!active_ || tid != active_task_ || activity_ != Activity::kLoading) {
          return;
        }
        if (!r.granted) {
          bay_retry_at_ = fleet_now_ + std::max(1.0, r.retry_after_s);
          return;
        }
        bay_granted_ = true;
        bay_wait_since_ = -1.0;
        const Vec3 hover{r.position.x, r.position.y,
          r.position.z + get_parameter("handoff_hover_agl_m").as_double()};
        if (!start_leg(hover, LegEnd::kHover, "to_bay")) {
          release_task(tid, "no_route_to_bay");
        }
      });
  }

  void request_pickup()
  {
    const core::Task * t = replica_.task(active_task_);
    if (t == nullptr) {
      abort_active("task_vanished");
      return;
    }
    // I3: never ask for a parcel with a lapsed lease.
    if (!own_->lease_valid(active_task_, local_now_)) {
      emit("ZOMBIE_STOP", core::Json().add("task_id", active_task_));
      release_task(active_task_, "lease_lapsed_at_bay");
      return;
    }
    auto it = pickup_clients_.find(t->origin_depot);
    if (it == pickup_clients_.end() || !it->second->service_is_ready()) {
      emit("PICKUP_UNAVAILABLE", core::Json().add("task_id", active_task_)
        .add("depot", t->origin_depot));
      release_task(active_task_, "depot_unavailable");
      return;
    }
    activity_ = Activity::kLoading;
    auto req = std::make_shared<aeropact_interfaces::srv::RequestPickup::Request>();
    req->task_id = active_task_;
    req->drone_id = id_;
    req->epoch = t->claim_epoch;
    const std::string tid = active_task_;
    it->second->async_send_request(req,
      [this, tid](rclcpp::Client<aeropact_interfaces::srv::RequestPickup>::SharedFuture f) {
        on_pickup_response(tid, *f.get());
      });
  }

  void on_pickup_response(
    const std::string & tid, const aeropact_interfaces::srv::RequestPickup::Response & res)
  {
    if (!active_ || tid != active_task_ || activity_ != Activity::kLoading) {
      return;
    }
    using Res = aeropact_interfaces::srv::RequestPickup::Response;
    if (res.result != Res::RESULT_GRANT) {
      emit("PICKUP_REFUSED", core::Json().add("task_id", tid)
        .add("result", static_cast<int>(res.result)).add("reason", res.reason));
      own_->forget(tid);
      remove_from_bundle(tid);
      active_task_.clear();
      activity_ = Activity::kHolding;
      return;
    }
    core::Task picked = from_msg(res.record);
    picked.state = TaskState::kPickedUp;
    picked.owner = id_;
    write_task(picked);
    own_->mark_sticky(tid);
    carrying_ = true;
    payload_kg_ = picked.weight_kg;
    reported_written_off_ = false;
    emit("PICKED_UP", core::Json().add("task_id", tid).add("epoch", picked.claim_epoch));
    const Vec3 hover{picked.drop.x, picked.drop.y, picked.drop.z +
      get_parameter("drop_hover_agl_m").as_double()};
    activity_ = Activity::kToDrop;
    if (!start_leg(hover, LegEnd::kHover, "to_drop")) {
      emit("ROUTE_FAILED", core::Json().add("task_id", tid).add("leg", "to_drop"));
    }
  }

  void complete_delivery()
  {
    const core::Task * t = replica_.task(active_task_);
    if (t == nullptr) {
      abort_active("task_vanished");
      return;
    }
    core::Task d = *t;
    d.state = TaskState::kDelivered;
    d.owner = id_;
    write_task(d);
    publish_payload(d.task_id, false);
    const double lateness = fleet_now_ - d.deadline;
    emit("DELIVERED", core::Json().add("task_id", d.task_id).add("on_time", lateness <= 0.0)
      .add("lateness_s", lateness).add("priority", static_cast<int>(d.priority))
      .add("replaces", d.replaces));
    if (hub_task_pub_) {
      hub_task_pub_->publish(to_msg(d));
    }
    own_->forget(d.task_id);
    remove_from_bundle(d.task_id);
    active_task_.clear();
    carrying_ = false;
    activity_ = Activity::kHolding;
  }

  void abort_active(const std::string & reason)
  {
    if (active_task_.empty()) {
      return;
    }
    emit("MISSION_ABORT", core::Json().add("task_id", active_task_).add("reason", reason));
    if (!carrying_) {
      cancel_goal();
      active_task_.clear();
      activity_ = Activity::kHolding;
    }
  }

  void return_parcel()
  {
    const core::Task * t = replica_.task(active_task_);
    const core::Depot * depot = t != nullptr ? world_->depot(t->origin_depot) :
      world_->nearest_depot(pos_);
    if (depot == nullptr) {
      divert_parcel_ = false;
      return;
    }
    returned_task_ = active_task_;
    active_task_.clear();
    const Vec3 hover{depot->handoff.x, depot->handoff.y, depot->handoff.z + 3.0};
    activity_ = Activity::kToPickup;
    start_leg(hover, LegEnd::kHover, "return_parcel");
  }

  // ---- parking and pads ----

  void park_if_needed()
  {
    if (activity_ == Activity::kCharging && pad_granted_) {
      return;  // on our pad
    }
    if (pad_granted_ && !goal_active_) {
      if (start_leg(pad_pos_, LegEnd::kLand, "to_pad")) {
        activity_ = Activity::kToPad;
      }
      return;
    }
    if (fleet_now_ - pad_request_time_ < 4.0) {
      return;  // waiting for an answer
    }
    // Ask the nearest depots in turn.
    std::vector<const core::Depot *> depots;
    for (const auto & d : world_->depots) {
      depots.push_back(&d);
    }
    std::sort(depots.begin(), depots.end(), [this](const core::Depot * a, const core::Depot * b) {
        return geom::dist_xy(a->position, pos_) < geom::dist_xy(b->position, pos_);
      });
    if (depots.empty()) {
      return;
    }
    const core::Depot * target = depots[pad_attempt_ % depots.size()];
    ++pad_attempt_;
    pad_request_time_ = fleet_now_;
    RadioFrame f = frame(RadioFrame::TYPE_PAD_REQUEST, target->id);
    aeropact_interfaces::msg::PadRequest r;
    r.drone_id = id_;
    r.depot_id = target->id;
    r.op = aeropact_interfaces::msg::PadRequest::OP_RESERVE;
    r.request_id = ++pad_request_id_;
    r.eta = fleet_now_ + energy_->flight_time_s(pos_, target->position, world_->wind, cruise_alt_);
    r.duration_s = 900.0;
    r.pad_id = pad_id_;
    f.pad_request.push_back(r);
    send(std::move(f));
    if (activity_ != Activity::kHolding) {
      activity_ = Activity::kHolding;
    }
  }

  void on_pad_response(const aeropact_interfaces::msg::PadResponse & r)
  {
    if (r.drone_id != id_ || r.request_id != pad_request_id_) {
      return;
    }
    pad_request_time_ = -1e9;
    if (!r.granted) {
      emit("PAD_DENIED", core::Json().add("depot", r.depot_id).add("reason", r.reason));
      return;
    }
    pad_id_ = r.pad_id;
    pad_pos_ = from_msg(r.pad_position);
    pad_granted_ = true;
    pad_attempt_ = 0;
    emit("PAD_GRANT", core::Json().add("pad", r.pad_id).add("depot", r.depot_id));
  }

  void leave_pad()
  {
    if (!pad_granted_ || pad_id_.empty()) {
      return;
    }
    const core::Pad * pad = world_->pad(pad_id_);
    RadioFrame f = frame(RadioFrame::TYPE_PAD_REQUEST, pad != nullptr ? pad->depot_id : "*");
    aeropact_interfaces::msg::PadRequest r;
    r.drone_id = id_;
    r.depot_id = pad != nullptr ? pad->depot_id : "";
    r.op = aeropact_interfaces::msg::PadRequest::OP_RELEASE;
    r.request_id = ++pad_request_id_;
    r.pad_id = pad_id_;
    f.pad_request.push_back(r);
    send(std::move(f));
    pad_granted_ = false;
  }

  // ---- flight legs ----

  bool start_leg(const Vec3 & target, LegEnd end, const std::string & purpose)
  {
    LegRequest req;
    req.from = pos_;
    req.to = target;
    req.cruise_alt = cruise_alt_;
    req.end = end;
    auto wps = build_leg(*planner_, req);
    if (!wps) {
      emit("ROUTE_FAILED", core::Json().add("purpose", purpose));
      return false;
    }
    if (!fly_client_->action_server_is_ready()) {
      RCLCPP_WARN_THROTTLE(get_logger(), *get_clock(), 5000, "flight manager not ready");
      return false;
    }
    cancel_goal();
    FlyRoute::Goal goal;
    for (const auto & w : *wps) {
      goal.waypoints.push_back(to_point(w));
    }
    goal.cruise_speed = static_cast<float>(get_parameter("cruise_speed_mps").as_double());
    goal.acceptance_radius = end == LegEnd::kLand ? 0.8f : 2.0f;
    goal.terminal = end == LegEnd::kLand ? FlyRoute::Goal::TERMINAL_LAND :
      FlyRoute::Goal::TERMINAL_HOVER;
    goal.purpose = purpose;
    leg_target_ = target;
    leg_end_ = end;
    leg_target_purpose_ = purpose;
    const std::uint64_t seq = ++goal_seq_;
    goal_active_ = true;
    rclcpp_action::Client<FlyRoute>::SendGoalOptions opts;
    opts.goal_response_callback = [this, seq](GoalHandle::SharedPtr h) {
        if (seq != goal_seq_) {
          return;
        }
        if (!h) {
          goal_active_ = false;
          on_leg_done(leg_target_purpose_, false, FlyRoute::Result::CODE_INVALID);
          return;
        }
        goal_handle_ = h;
      };
    opts.result_callback = [this, seq, purpose](const GoalHandle::WrappedResult & r) {
        if (seq != goal_seq_ || !active_) {
          return;
        }
        goal_active_ = false;
        goal_handle_.reset();
        const bool ok = r.code == rclcpp_action::ResultCode::SUCCEEDED && r.result &&
          r.result->success;
        on_leg_done(purpose, ok, r.result ? r.result->code : FlyRoute::Result::CODE_INVALID);
      };
    fly_client_->async_send_goal(goal, opts);
    return true;
  }

  void cancel_goal()
  {
    ++goal_seq_;  // results of the old goal are ignored from now on
    goal_active_ = false;
    leg_target_purpose_.clear();
    if (goal_handle_) {
      fly_client_->async_cancel_goal(goal_handle_);
      goal_handle_.reset();
    }
  }

  void publish_payload(const std::string & tid, bool attached)
  {
    aeropact_interfaces::msg::PayloadEvent p;
    p.drone_id = id_;
    p.task_id = tid;
    p.attached = attached;
    if (const core::Task * t = replica_.task(tid)) {
      p.mass_kg = t->weight_kg;
    }
    payload_pub_->publish(p);
  }

  // ---------------------------------------------------------------- radio out

  void radio_step()
  {
    if (local_now_ - last_hb_ >= get_parameter("heartbeat_period_s").as_double()) {
      last_hb_ = local_now_;
      send_heartbeat();
    }
    if (local_now_ - last_gossip_ >= get_parameter("gossip_period_s").as_double()) {
      last_gossip_ = local_now_;
      upsert_self();
      const bool full = local_now_ - last_full_ >=
        get_parameter("full_sync_period_s").as_double();
      core::Delta d = full ? replica_.full_state() : replica_.delta_since(gossip_version_);
      if (full) {
        last_full_ = local_now_;
      }
      gossip_version_ = replica_.version();
      if (!d.empty()) {
        RadioFrame f = frame(RadioFrame::TYPE_GOSSIP_DELTA, "*");
        f.gossip.push_back(to_msg(d));
        send(std::move(f));
      }
    }
    if (hub_uplink_ && fleet_now_ - last_uplink_ >= 1.0) {
      last_uplink_ = fleet_now_;
      core::DroneInfo me = self_info();
      hub_uplink_->publish(to_msg(me));
    }
  }

  core::DroneInfo self_info()
  {
    core::DroneInfo me;
    me.drone_id = id_;
    me.seq = ++status_seq_;
    me.position = pos_;
    me.velocity = vel_;
    me.soc = static_cast<float>(soc_);
    me.capacity_kg = static_cast<float>(get_parameter("capacity_kg").as_double());
    me.health = health_;
    me.mode = link_mode_;
    me.activity = activity_;
    me.bundle = bundle_;
    me.known_peers.assign(view_.reachable.begin(), view_.reachable.end());
    me.t_local = local_now_;
    return me;
  }

  /// Re-publish our own status only when it changed meaningfully (or every 5 s), so that a
  /// quiet fleet sends heartbeats and periodic anti-entropy only (REQ-STATE-003, M6).
  void upsert_self()
  {
    const bool moved = geom::dist(pos_, last_self_.position) > 10.0;
    const bool changed = activity_ != last_self_.activity || bundle_ != last_self_.bundle ||
      link_mode_ != last_self_.mode || health_ != last_self_.health ||
      std::abs(soc_ - static_cast<double>(last_self_.soc)) >= 0.02;
    if (!moved && !changed && local_now_ - last_self_time_ < 5.0) {
      return;
    }
    last_self_ = self_info();
    last_self_time_ = local_now_;
    replica_.upsert_drone(last_self_);
  }

  void send_heartbeat()
  {
    RadioFrame f = frame(RadioFrame::TYPE_HEARTBEAT, "*");
    aeropact_interfaces::msg::Heartbeat hb;
    hb.node_id = id_;
    hb.seq = ++hb_seq_;
    hb.is_depot = false;
    hb.position = to_point(pos_);
    hb.soc = static_cast<float>(soc_);
    hb.health = static_cast<uint8_t>(health_);
    hb.max_endurance_s = energy_->max_endurance_s(soc_);
    for (const auto & [tid, ep] : ack_tasks_) {
      hb.ack_task_ids.push_back(tid);
      hb.ack_epochs.push_back(ep.first);
      hb.ack_lease_seqs.push_back(ep.second);
    }
    for (const auto & [sid, ep] : ack_shards_) {
      hb.ack_shard_ids.push_back(sid);
      hb.ack_shard_epochs.push_back(ep.first);
      hb.ack_shard_lease_seqs.push_back(ep.second);
    }
    ack_tasks_.clear();
    ack_shards_.clear();
    f.heartbeat.push_back(hb);
    send(std::move(f));
  }

  RadioFrame frame(uint8_t type, const std::string & dst)
  {
    RadioFrame f;
    f.version = RadioFrame::VERSION;
    f.type = type;
    f.src = id_;
    f.dst = dst;
    f.seq = ++frame_seq_;
    f.sig = "stub";
    return f;
  }

  void send(RadioFrame && f)
  {
    if (radio_silent_ || !radio_tx_->is_activated()) {
      return;
    }
    ++frames_tx_;
    radio_tx_->publish(std::move(f));
  }

  // ---------------------------------------------------------------- state helpers

  void write_task(const core::Task & t)
  {
    replica_.upsert_task(t, local_now_);
    if (hub_task_pub_ && t.owner == id_) {
      hub_task_pub_->publish(to_msg(t));
    }
  }

  void emit(const std::string & type, const core::Json & data)
  {
    if (!event_pub_ || !event_pub_->is_activated()) {
      return;
    }
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = id_;
    ev.type = type;
    ev.data = data.str();
    event_pub_->publish(ev);
  }

  void publish_status()
  {
    aeropact_interfaces::msg::CoordinatorStatus s;
    s.header.stamp = now();
    s.header.frame_id = "map";
    s.drone_id = id_;
    s.mode = static_cast<uint8_t>(link_mode_);
    s.activity = static_cast<uint8_t>(activity_);
    s.partition_policy = core::to_string(policy_kind_);
    s.allocation_mode = get_parameter("allocation_mode").as_string();
    s.bundle = bundle_;
    s.current_task = active_task_;
    s.replica_tasks = static_cast<uint32_t>(replica_.tasks().size());
    s.replica_version = replica_.version();
    s.task_digest = replica_.task_digest();
    for (const auto & [pid, p] : fd_->peers()) {
      aeropact_interfaces::msg::PeerInfo pi;
      pi.id = pid;
      pi.state = static_cast<uint8_t>(p.state);
      pi.phi = std::min(p.phi, 1e6);
      pi.last_heard_age_s = fd_->last_heard_age(pid, local_now_);
      s.peers.push_back(pi);
    }
    s.reachable_members = static_cast<uint32_t>(view_.reachable.size());
    s.known_members = static_cast<uint32_t>(view_.known.size());
    s.frames_sent = frames_tx_;
    s.frames_received = frames_rx_;
    s.local_clock = local_now_;
    s.clock_drift_ppm = clock_.drift_ppm();
    status_pub_->publish(s);
  }

  // ---------------------------------------------------------------- members

  // configuration
  std::string id_;
  std::vector<std::string> roster_;
  std::vector<std::string> depot_ids_;
  std::string home_pad_;
  AllocationMode mode_{AllocationMode::kPact};
  core::PartitionPolicyKind policy_kind_{core::PartitionPolicyKind::kQuorum};
  double cruise_alt_{35.0};
  bool use_shard_leases_{true};
  double shard_ttl_{30.0};

  // algorithms
  std::unique_ptr<core::WorldModel> world_;
  std::unique_ptr<core::EnergyModel> energy_;
  std::unique_ptr<core::Auction> auction_;
  std::unique_ptr<core::RoutePlanner> planner_;
  std::unique_ptr<core::OwnershipManager> own_;
  std::unique_ptr<core::PartitionPolicy> policy_;
  std::unique_ptr<core::FailureDetector> fd_;
  core::HexGrid hex_;
  core::LocalClock clock_;
  core::FleetReplica replica_;
  core::MembershipView view_;

  // vehicle state
  bool active_{false};
  bool have_odom_{false};
  bool have_battery_{false};
  bool have_safety_{false};
  Vec3 pos_;
  Vec3 vel_;
  double soc_{1.0};
  SafetyStatus safety_;
  core::Health health_{core::Health::kOk};
  core::LinkMode link_mode_{core::LinkMode::kSolo};
  Activity activity_{Activity::kIdle};
  std::vector<std::string> bundle_;
  std::string active_task_;
  bool carrying_{false};
  bool divert_parcel_{false};
  std::string returned_task_;
  double drop_until_{0.0};
  bool radio_silent_{false};
  bool urgent_{true};
  bool replan_pending_{false};

  // pads
  std::string pad_id_;
  Vec3 pad_pos_;
  bool pad_granted_{false};
  std::uint64_t pad_request_id_{0};
  double pad_request_time_{-1e9};
  std::size_t pad_attempt_{0};

  // flight
  rclcpp_action::Client<FlyRoute>::SharedPtr fly_client_;
  GoalHandle::SharedPtr goal_handle_;
  bool goal_active_{false};
  std::uint64_t goal_seq_{0};
  Vec3 leg_target_;
  LegEnd leg_end_{LegEnd::kHover};
  std::string leg_target_purpose_;

  // shard leases
  std::map<std::string, HeldShard> my_shards_;
  std::map<std::string, std::pair<std::tuple<std::uint32_t, std::uint32_t, std::string>, double>>
  shard_observed_;
  double last_shard_scan_{-1e9};

  core::DroneInfo last_self_;
  double calib_t_{-1.0};
  double calib_soc_{-1.0};
  double calib_pred_{0.0};
  double payload_kg_{0.0};
  bool energy_divert_{false};
  bool reported_written_off_{false};
  double last_self_time_{-1e9};

  // timing
  double fleet_now_{0.0};
  double local_now_{0.0};
  double last_auction_{-1e9};
  double last_hb_{-1e9};
  double last_gossip_{-1e9};
  double last_full_{-1e9};
  double last_status_{-1e9};
  double last_prune_{0.0};
  double last_uplink_{-1e9};
  double hub_last_seen_{-1e9};
  double hlc_seen_{0.0};

  // radio
  std::deque<RadioFrame::UniquePtr> inbox_;
  std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> ack_tasks_;
  std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> ack_shards_;
  std::uint64_t gossip_version_{0};
  std::uint64_t frame_seq_{0};
  std::uint64_t hb_seq_{0};
  std::uint64_t status_seq_{0};
  std::uint64_t probe_nonce_{0};
  std::uint64_t frames_tx_{0};
  std::uint64_t frames_rx_{0};

  // ROS interfaces
  rclcpp_lifecycle::LifecyclePublisher<RadioFrame>::SharedPtr radio_tx_;
  rclcpp::Subscription<RadioFrame>::SharedPtr radio_rx_;
  rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr odom_sub_;
  rclcpp::Subscription<sensor_msgs::msg::BatteryState>::SharedPtr battery_sub_;
  rclcpp::Subscription<SafetyStatus>::SharedPtr safety_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::AirspaceRestrictionArray>::SharedPtr
    airspace_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::AssignmentArray>::SharedPtr hub_sub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::CoordinatorStatus>::SharedPtr
    status_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr
    event_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::PayloadEvent>::SharedPtr
    payload_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::DroneState>::SharedPtr
    hub_uplink_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::TaskRecord>::SharedPtr
    hub_task_pub_;
  std::map<std::string, rclcpp::Client<aeropact_interfaces::srv::RequestPickup>::SharedPtr>
  pickup_clients_;
  std::map<std::string, rclcpp::Client<aeropact_interfaces::srv::ReserveBay>::SharedPtr>
  bay_clients_;
  bool bay_pending_{false};
  bool bay_granted_{false};
  double bay_retry_at_{0.0};
  double bay_wait_since_{-1.0};
  rclcpp::Service<aeropact_interfaces::srv::InjectFault>::SharedPtr fault_srv_;
  rclcpp::node_interfaces::OnSetParametersCallbackHandle::SharedPtr param_cb_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::agent

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::agent::CoordinatorNode)
