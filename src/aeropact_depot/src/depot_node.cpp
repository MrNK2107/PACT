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
#include <deque>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "aeropact_agent/conversions.hpp"
#include "aeropact_core/hexgrid.hpp"
#include "aeropact_core/json.hpp"
#include "aeropact_core/replica.hpp"
#include "aeropact_core/task_ids.hpp"
#include "aeropact_core/world_model.hpp"
#include "aeropact_depot/arbiter.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/pad_occupancy.hpp"
#include "aeropact_interfaces/msg/payload_event.hpp"
#include "aeropact_interfaces/msg/radio_frame.hpp"
#include "aeropact_interfaces/srv/inject_fault.hpp"
#include "aeropact_interfaces/srv/request_pickup.hpp"
#include "aeropact_interfaces/srv/reserve_bay.hpp"
#include "aeropact_interfaces/srv/submit_order.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"

namespace aeropact::depot
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using RadioFrame = aeropact_interfaces::msg::RadioFrame;
using core::TaskState;
using core::Vec3;
namespace conv = aeropact::agent;

/**
 * Depot node (one per depot, namespace /depots/<id>). Holds a replica, gossips and heartbeats like
 * a drone (so it relays state and acknowledges leases), and owns the depot's physical resources:
 * the parcel shelf (hand-off arbitration) and the charging pads. It never assigns work.
 */
class DepotNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit DepotNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("depot", options), hex_(150.0)
  {
    declare_parameter("depot_id", "D1");
    declare_parameter("world_file", "");
    declare_parameter("fleet_roster", std::vector<std::string>{});
    declare_parameter("initial_assignments", std::vector<std::string>{});  // "A01:D1-P1"
    declare_parameter("arbitration", true);
    declare_parameter("handoff_radius_m", 8.0);
    declare_parameter("handoff_max_agl_m", 8.0);
    declare_parameter("gossip_period_s", 1.0);
    declare_parameter("full_sync_period_s", 10.0);
    declare_parameter("heartbeat_period_s", 1.0);
    declare_parameter("forward_to_hub", false);
    // Where vehicle positions come from: "odom" (the vehicles' odometry topics, as a depot's own
    // sensing in simulation) or "radio" (the authenticated heartbeats on the mesh; deployment).
    declare_parameter("position_source", "odom");
    // Pad occupancy sensors (D-31), empty disables: an occupied pad is never granted, a vacated
    // one is freed.
    declare_parameter("pad_sensor_topic", "");
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    id_ = get_parameter("depot_id").as_string();
    try {
      world_ = std::make_unique<core::WorldModel>(
        core::WorldModel::load(get_parameter("world_file").as_string()));
    } catch (const std::exception & e) {
      RCLCPP_ERROR(get_logger(), "cannot load world: %s", e.what());
      return CallbackReturn::FAILURE;
    }
    depot_ = world_->depot(id_);
    if (depot_ == nullptr) {
      RCLCPP_ERROR(get_logger(), "depot %s not in world", id_.c_str());
      return CallbackReturn::FAILURE;
    }
    hex_ = core::HexGrid(world_->shard_size_m);
    parcels_ = ParcelArbiter(get_parameter("arbitration").as_bool());
    for (const auto & pid : depot_->pad_ids) {
      pads_.add_pad(pid, world_->pad(pid)->position);
    }
    for (std::size_t i = 0; i < depot_->bays.size(); ++i) {
      bays_.add_bay(id_ + "-B" + std::to_string(i + 1), depot_->bays[i]);
    }
    const std::vector<std::string> assignments =
      get_parameter("initial_assignments").as_string_array();
    for (const auto & a : assignments) {
      const auto colon = a.find(':');
      if (colon != std::string::npos) {
        pads_.assign(a.substr(0, colon), a.substr(colon + 1));
      }
    }

    const auto radio_qos = rclcpp::QoS(200).best_effort();
    radio_tx_ = create_publisher<RadioFrame>("radio/tx", radio_qos);
    radio_rx_ = create_subscription<RadioFrame>("radio/rx", radio_qos,
        [this](RadioFrame::UniquePtr f) {inbox_.push_back(std::move(f));});
    events_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(500).reliable());
    payload_pub_ = create_publisher<aeropact_interfaces::msg::PayloadEvent>(
      "/sim/payload", rclcpp::QoS(50).reliable());
    if (get_parameter("forward_to_hub").as_bool()) {
      hub_orders_ = create_publisher<aeropact_interfaces::msg::TaskRecord>(
        "/hub/orders", rclcpp::QoS(100).reliable());
    }
    const std::vector<std::string> roster = get_parameter("fleet_roster").as_string_array();
    roster_.clear();
    roster_.insert(roster.begin(), roster.end());
    position_from_radio_ = get_parameter("position_source").as_string() == "radio";
    if (!position_from_radio_) {
      for (const auto & d : roster) {
        odom_subs_.push_back(create_subscription<nav_msgs::msg::Odometry>(
            "/" + d + "/odom", rclcpp::SensorDataQoS(),
            [this, d](nav_msgs::msg::Odometry::ConstSharedPtr m) {
              observe_vehicle(d, {m->pose.pose.position.x, m->pose.pose.position.y,
                m->pose.pose.position.z});
            }));
      }
    }
    const auto pad_topic = get_parameter("pad_sensor_topic").as_string();
    if (!pad_topic.empty()) {
      pad_sensor_sub_ = create_subscription<aeropact_interfaces::msg::PadOccupancy>(
        pad_topic, rclcpp::QoS(50),
        [this](aeropact_interfaces::msg::PadOccupancy::ConstSharedPtr m) {on_pad_sensor(*m);});
    }
    submit_srv_ = create_service<aeropact_interfaces::srv::SubmitOrder>("submit_order",
        [this](const std::shared_ptr<aeropact_interfaces::srv::SubmitOrder::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::SubmitOrder::Response> rs) {
          on_submit(*rq, *rs);
        });
    bay_srv_ = create_service<aeropact_interfaces::srv::ReserveBay>("reserve_bay",
        [this](const std::shared_ptr<aeropact_interfaces::srv::ReserveBay::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::ReserveBay::Response> rs) {
          if (!active_ || offline_) {
            rs->granted = false;
            rs->reason = "depot offline";
            rs->retry_after_s = 5.0;
            return;
          }
          const bool had = bays_.held_by(rq->drone_id) != nullptr;
          const auto bay = bays_.reserve(rq->drone_id, now().seconds());
          rs->granted = bay.has_value();
          if (bay) {
            rs->bay_id = bay->id;
            rs->position = conv::to_point(bay->position);
            if (!had) {
              emit("BAY_GRANT", core::Json().add("bay", bay->id).add("drone", rq->drone_id)
              .add("task_id", rq->task_id));
            }
          } else {
            rs->retry_after_s = 3.0;
            rs->reason = "all bays busy";
          }
        });
    pickup_srv_ = create_service<aeropact_interfaces::srv::RequestPickup>("request_pickup",
        [this](const std::shared_ptr<aeropact_interfaces::srv::RequestPickup::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::RequestPickup::Response> rs) {
          on_pickup(*rq, *rs);
        });
    fault_srv_ = create_service<aeropact_interfaces::srv::InjectFault>("inject_fault",
        [this](const std::shared_ptr<aeropact_interfaces::srv::InjectFault::Request> rq,
        std::shared_ptr<aeropact_interfaces::srv::InjectFault::Response> rs) {
          on_fault(*rq, *rs);
        });
    RCLCPP_INFO(get_logger(), "depot %s configured: %zu pads, arbitration=%s", id_.c_str(),
      depot_->pad_ids.size(), get_parameter("arbitration").as_bool() ? "on" : "off");
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    radio_tx_->on_activate();
    events_->on_activate();
    payload_pub_->on_activate();
    if (hub_orders_) {
      hub_orders_->on_activate();
    }
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(0.1),
        [this]() {tick();});
    active_ = true;
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    active_ = false;
    if (timer_) {
      timer_->cancel();
    }
    radio_tx_->on_deactivate();
    events_->on_deactivate();
    payload_pub_->on_deactivate();
    if (hub_orders_) {
      hub_orders_->on_deactivate();
    }
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    odom_subs_.clear();
    pad_sensor_sub_.reset();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  double local_now() {return now().seconds();}  // depots have a stable, GPS-disciplined clock

  /// A pad occupancy sensor report for one of this depot's pads (D-31).
  void on_pad_sensor(const aeropact_interfaces::msg::PadOccupancy & m)
  {
    if (m.depot_id != id_ || pads_.pads().count(m.pad_id) == 0U) {
      return;
    }
    const std::string holder = pads_.pads().at(m.pad_id).holder;
    const bool was = sensed_occupied_.count(m.pad_id) != 0U;
    if (m.occupied != was) {
      if (m.occupied) {
        sensed_occupied_.insert(m.pad_id);
      } else {
        sensed_occupied_.erase(m.pad_id);
      }
      emit("PAD_SENSOR", core::Json().add("pad", m.pad_id).add("occupied", m.occupied)
        .add("holder", holder));
    }
    if (pads_.sense(m.pad_id, m.occupied)) {
      for (const auto & r : replica_.pad_reservations()) {
        if (r.pad_id == m.pad_id && r.drone_id == holder) {
          replica_.remove_pad_reservation(r.tag);
        }
      }
      emit("PAD_RELEASED", core::Json().add("pad", m.pad_id).add("drone", holder)
        .add("reason", "pad_sensor_vacated"));
    }
  }

  /// A vehicle position update: frees pads and bays their holders have left (D-13, D-18).
  void observe_vehicle(const std::string & d, const Vec3 & p)
  {
    positions_[d] = p;
    for (const auto & pad : pads_.observe(d, p, now().seconds())) {
      for (const auto & r : replica_.pad_reservations()) {
        if (r.pad_id == pad && r.drone_id == d) {
          replica_.remove_pad_reservation(r.tag);
        }
      }
      emit("PAD_RELEASED", core::Json().add("pad", pad).add("drone", d)
        .add("reason", "holder_left"));
    }
    for (const auto & bay : bays_.observe(d, p, now().seconds(),
      get_parameter("handoff_radius_m").as_double(), 20.0, 120.0))
    {
      emit("BAY_RELEASED", core::Json().add("bay", bay).add("drone", d));
    }
  }

  void tick()
  {
    if (!active_) {
      return;
    }
    const double t = local_now();
    while (!inbox_.empty()) {
      RadioFrame::UniquePtr f = std::move(inbox_.front());
      inbox_.pop_front();
      if (offline_ || f->version > RadioFrame::VERSION || f->src == id_) {
        continue;
      }
      if (f->dst != "*" && f->dst != id_) {
        continue;
      }
      if (f->type == RadioFrame::TYPE_GOSSIP_DELTA && !f->gossip.empty()) {
        const auto r = replica_.apply(conv::from_msg(f->gossip.front()), t);
        on_merged(r);
      } else if (f->type == RadioFrame::TYPE_PAD_REQUEST && !f->pad_request.empty()) {
        on_pad_request(f->pad_request.front());
      } else if (f->type == RadioFrame::TYPE_PROBE && !f->probe.empty()) {
        // Depots answer probes from what they heard recently.
        const auto & p = f->probe.front();
        RadioFrame a = frame(RadioFrame::TYPE_PROBE_ACK, p.requester);
        aeropact_interfaces::msg::ProbeAck ack;
        ack.responder = id_;
        ack.requester = p.requester;
        ack.target = p.target;
        ack.nonce = p.nonce;
        auto it = last_heard_.find(p.target);
        ack.last_heard_age_s = it == last_heard_.end() ? 1e9 : t - it->second;
        ack.heard_recently = ack.last_heard_age_s < 3.0;
        a.probe_ack.push_back(ack);
        send(std::move(a));
      }
      if (f->type == RadioFrame::TYPE_HEARTBEAT && !f->heartbeat.empty()) {
        const auto & hb = f->heartbeat.front();
        last_heard_[hb.node_id] = t;
        if (position_from_radio_ && !hb.is_depot && roster_.count(hb.node_id) != 0U) {
          observe_vehicle(hb.node_id, {hb.position.x, hb.position.y, hb.position.z});
        }
      }
    }
    if (offline_) {
      return;
    }
    if (t - last_hb_ >= get_parameter("heartbeat_period_s").as_double()) {
      last_hb_ = t;
      heartbeat();
    }
    if (t - last_gossip_ >= get_parameter("gossip_period_s").as_double()) {
      last_gossip_ = t;
      const bool full = t - last_full_ >= get_parameter("full_sync_period_s").as_double();
      core::Delta d = full ? replica_.full_state() : replica_.delta_since(gossip_version_);
      if (full) {
        last_full_ = t;
      }
      gossip_version_ = replica_.version();
      if (!d.empty()) {
        RadioFrame f = frame(RadioFrame::TYPE_GOSSIP_DELTA, "*");
        f.gossip.push_back(conv::to_msg(d));
        send(std::move(f));
      }
    }
    if (t - last_prune_ > 30.0) {
      last_prune_ = t;
      replica_.prune(t);
    }
  }

  void on_merged(const core::MergeResult & r)
  {
    for (const auto & tr : r.tasks) {
      const core::Task & t = tr.after;
      const bool leased = t.state == TaskState::kClaimed || t.state == TaskState::kCommitted;
      if (leased && !t.owner.empty()) {
        auto & a = ack_tasks_[t.task_id];
        a = std::max(a, std::make_pair(t.claim_epoch, t.lease_seq));
      }
      // Lost parcels from this depot are re-ordered once (REQ-FAIL-004).
      if (t.state == TaskState::kDelivered && reordered_.count(t.task_id) != 0U) {
        const core::Task * repl = replica_.task(t.task_id + "-R");
        if (repl != nullptr && core::is_pre_pickup(repl->state)) {
          core::Task c = *repl;
          c.state = TaskState::kAborted;
          c.abort_reason = "original_delivered";
          replica_.upsert_task(c, local_now());
          emit("REPLACEMENT_CANCELLED", core::Json().add("task_id", c.task_id)
            .add("original", t.task_id));
        }
      }
      // A cancelled replacement is not a lost parcel.
      if (t.state == TaskState::kAborted && t.origin_depot == id_ &&
        t.abort_reason != "original_delivered" && reordered_.count(t.task_id) == 0U)
      {
        reordered_.insert(t.task_id);
        reorder(t);
      }
    }
    for (const auto & l : r.shard_changes) {
      auto & a = ack_shards_[l.shard_id];
      a = std::max(a, std::make_pair(l.epoch, l.lease_seq));
    }
  }

  void reorder(const core::Task & lost)
  {
    core::Task t = lost;
    t.task_id = lost.task_id + "-R";
    t.replaces = lost.replaces.empty() ? lost.task_id : lost.replaces;
    t.state = TaskState::kUnassigned;
    t.owner.clear();
    t.epoch = 0;
    t.claim_epoch = 0;
    t.bid = 0.0;
    t.lease_seq = 0;
    t.lease_ttl = 0.0;
    t.abort_reason.clear();
    t.created_at = now().seconds();
    // Keep the original deadline: recovery is measured against the customer promise, but give
    // urgent parcels priority 1 so they re-auction immediately.
    t.priority = std::min<std::uint8_t>(t.priority, 2);
    replica_.upsert_task(t, local_now());
    emit("TASK_REORDERED", core::Json().add("task_id", t.task_id).add("replaces", t.replaces)
      .add("reason", lost.abort_reason).add("deadline", t.deadline));
    emit("TASK_CREATED", task_json(t));
  }

  core::Json task_json(const core::Task & t)
  {
    core::Json j;
    j.add("task_id", t.task_id).add("priority", static_cast<int>(t.priority))
    .add("deadline", t.deadline).add("created_at", t.created_at).add("origin", t.origin_depot)
    .add("shard", t.shard).add("weight_kg", static_cast<double>(t.weight_kg))
    .add("replaces", t.replaces).add("drop_x", t.drop.x).add("drop_y", t.drop.y);
    return j;
  }

  void on_submit(
    const aeropact_interfaces::srv::SubmitOrder::Request & rq,
    aeropact_interfaces::srv::SubmitOrder::Response & rs)
  {
    if (!active_ || offline_) {
      rs.accepted = false;
      rs.reason = "depot offline";
      return;
    }
    core::Task t;
    const double t_now = now().seconds();
    t.task_id = rq.task_id.empty() ?
      core::make_task_id(id_, hlc_.tick(t_now), ++nonce_) : rq.task_id;
    t.origin_depot = id_;
    t.pickup = depot_->handoff;
    t.drop = conv::from_msg(rq.drop);
    if (!rq.drop_id.empty()) {
      if (const core::DropPoint * dp = world_->drop_point(rq.drop_id)) {
        t.drop = dp->position;
      }
    }
    t.priority = std::clamp<std::uint8_t>(rq.priority, 1, 3);
    t.deadline = t_now + rq.deadline_offset_s;
    t.weight_kg = rq.weight_kg;
    t.shard = hex_.shard_of(t.drop.x, t.drop.y);
    t.created_at = t_now;
    if (replica_.task(t.task_id) != nullptr) {
      rs.accepted = false;
      rs.reason = "duplicate task id";
      return;
    }
    replica_.upsert_task(t, local_now());
    rs.accepted = true;
    rs.task_id = t.task_id;
    emit("TASK_CREATED", task_json(t));
    if (hub_orders_) {
      hub_orders_->publish(conv::to_msg(t));
    }
  }

  void on_pickup(
    const aeropact_interfaces::srv::RequestPickup::Request & rq,
    aeropact_interfaces::srv::RequestPickup::Response & rs)
  {
    using Res = aeropact_interfaces::srv::RequestPickup::Response;
    if (!active_ || offline_) {
      rs.result = Res::RESULT_DEPOT_OFFLINE;
      rs.reason = "depot offline";
      return;
    }
    // A bay only serves a drone that is physically there.
    auto it = positions_.find(rq.drone_id);
    const double radius = get_parameter("handoff_radius_m").as_double();
    bool at_bay = false;
    if (it != positions_.end()) {
      for (const auto & bay : bays_.bays()) {
        const bool allowed = bay.holder.empty() || bay.holder == rq.drone_id;
        if (allowed && geom::dist_xy(it->second, bay.position) <= radius &&
          it->second.z - bay.position.z <= get_parameter("handoff_max_agl_m").as_double())
        {
          at_bay = true;
        }
      }
    }
    if (!at_bay) {
      rs.result = Res::RESULT_NOT_AT_BAY;
      rs.reason = "not at the hand-off bay";
      emit("PICKUP_REFUSED", core::Json().add("task_id", rq.task_id).add("drone", rq.drone_id)
        .add("epoch", rq.epoch).add("result", "NOT_AT_BAY"));
      return;
    }
    const core::Task * known = replica_.task(rq.task_id);
    const PickupResult r = parcels_.request(known, rq.task_id, rq.drone_id, rq.epoch);
    rs.result = static_cast<uint8_t>(r);
    if (r != PickupResult::kGrant) {
      static const char * names[] = {"GRANT", "TASK_TAKEN", "STALE_EPOCH", "NOT_AT_BAY",
        "UNKNOWN_TASK", "DEPOT_OFFLINE"};
      rs.reason = names[static_cast<int>(r)];
      emit("PICKUP_REFUSED", core::Json().add("task_id", rq.task_id).add("drone", rq.drone_id)
        .add("epoch", rq.epoch).add("result", rs.reason)
        .add("known_epoch", known != nullptr ? known->epoch : 0U)
        .add("known_owner", known != nullptr ? known->owner : ""));
      return;
    }
    core::Task rec = known != nullptr ? *known : core::Task{};
    rec.task_id = rq.task_id;
    rec.state = TaskState::kPickedUp;
    rec.owner = rq.drone_id;
    rec.claim_epoch = std::max(rec.claim_epoch, rq.epoch);
    rec.epoch = std::max(rec.epoch, rec.claim_epoch);
    if (known != nullptr) {
      replica_.upsert_task(rec, local_now());
    }
    rs.record = conv::to_msg(rec);
    aeropact_interfaces::msg::PayloadEvent p;
    p.drone_id = rq.drone_id;
    p.task_id = rq.task_id;
    p.mass_kg = rec.weight_kg;
    p.attached = true;
    payload_pub_->publish(p);
    emit("PICKUP_GRANT", core::Json().add("task_id", rq.task_id).add("drone", rq.drone_id)
      .add("epoch", rq.epoch).add("parcels_handed", parcels_.parcels_handed()));
  }

  void on_pad_request(const aeropact_interfaces::msg::PadRequest & rq)
  {
    if (rq.depot_id != id_) {
      return;
    }
    if (rq.op == aeropact_interfaces::msg::PadRequest::OP_RELEASE) {
      for (const auto & [pid, p] : pads_.pads()) {
        if (p.holder == rq.drone_id && !p.tag.empty()) {
          replica_.remove_pad_reservation(p.tag);
        }
      }
      if (pads_.release(rq.drone_id, rq.pad_id)) {
        emit("PAD_RELEASED", core::Json().add("pad", rq.pad_id).add("drone", rq.drone_id));
      }
      return;
    }
    RadioFrame f = frame(RadioFrame::TYPE_PAD_RESPONSE, rq.drone_id);
    aeropact_interfaces::msg::PadResponse resp;
    resp.depot_id = id_;
    resp.drone_id = rq.drone_id;
    resp.request_id = rq.request_id;
    const auto pad = pads_.reserve(rq.drone_id, now().seconds());
    if (pad) {
      resp.granted = true;
      resp.pad_id = pad->id;
      resp.pad_position = conv::to_point(pad->position);
      core::PadReservation r{rq.drone_id + ":" + std::to_string(rq.request_id), pad->id, id_,
        rq.drone_id, rq.eta, rq.eta + rq.duration_s, 0};
      replica_.add_pad_reservation(r);
      emit("PAD_GRANT", core::Json().add("pad", pad->id).add("drone", rq.drone_id));
    } else {
      resp.granted = false;
      resp.retry_after_s = 5.0;
      resp.reason = "no free powered pad";
      emit("PAD_DENIED", core::Json().add("drone", rq.drone_id).add("reason", resp.reason));
    }
    f.pad_response.push_back(resp);
    send(std::move(f));
  }

  void on_fault(
    const aeropact_interfaces::srv::InjectFault::Request & rq,
    aeropact_interfaces::srv::InjectFault::Response & rs)
  {
    rs.success = true;
    const bool restore = rq.args.find("\"restore\":true") != std::string::npos;
    if (rq.type == "depot_outage") {
      offline_ = !restore;
      pads_.set_all_powered(restore);
    } else if (rq.type == "pad_outage") {
      const auto key = rq.args.find("\"pad\":\"");
      if (key == std::string::npos) {
        rs.success = false;
        rs.message = "pad_outage needs {\"pad\": id}";
        return;
      }
      const auto start = key + 7;
      pads_.set_powered(rq.args.substr(start, rq.args.find('"', start) - start), restore);
    } else {
      rs.success = false;
      rs.message = "unknown fault";
      return;
    }
    emit("FAULT_APPLIED", core::Json().add("type", rq.type).add("restore", restore));
  }

  void heartbeat()
  {
    RadioFrame f = frame(RadioFrame::TYPE_HEARTBEAT, "*");
    aeropact_interfaces::msg::Heartbeat hb;
    hb.node_id = id_;
    hb.seq = ++hb_seq_;
    hb.is_depot = true;
    hb.position = conv::to_point(depot_->position);
    hb.soc = 1.0f;
    hb.max_endurance_s = 1e9;
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
    if (radio_tx_->is_activated() && !offline_) {
      radio_tx_->publish(std::move(f));
    }
  }

  void emit(const std::string & type, const core::Json & data)
  {
    if (!events_->is_activated()) {
      return;
    }
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = id_;
    ev.type = type;
    ev.data = data.str();
    events_->publish(ev);
  }

  std::string id_;
  std::unique_ptr<core::WorldModel> world_;
  const core::Depot * depot_{nullptr};
  core::HexGrid hex_;
  core::FleetReplica replica_;
  core::HybridLogicalClock hlc_;
  std::uint32_t nonce_{0};
  ParcelArbiter parcels_;
  PadArbiter pads_;
  BayArbiter bays_;
  std::set<std::string> reordered_;
  std::map<std::string, Vec3> positions_;
  std::set<std::string> roster_;
  rclcpp::Subscription<aeropact_interfaces::msg::PadOccupancy>::SharedPtr pad_sensor_sub_;
  std::set<std::string> sensed_occupied_;
  bool position_from_radio_{false};
  std::map<std::string, double> last_heard_;
  std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> ack_tasks_;
  std::map<std::string, std::pair<std::uint32_t, std::uint32_t>> ack_shards_;
  std::deque<RadioFrame::UniquePtr> inbox_;
  bool active_{false};
  bool offline_{false};
  double last_hb_{-1e9};
  double last_gossip_{-1e9};
  double last_full_{-1e9};
  double last_prune_{0.0};
  std::uint64_t gossip_version_{0};
  std::uint64_t frame_seq_{0};
  std::uint64_t hb_seq_{0};

  rclcpp_lifecycle::LifecyclePublisher<RadioFrame>::SharedPtr radio_tx_;
  rclcpp::Subscription<RadioFrame>::SharedPtr radio_rx_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr events_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::PayloadEvent>::SharedPtr
    payload_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::TaskRecord>::SharedPtr
    hub_orders_;
  std::vector<rclcpp::Subscription<nav_msgs::msg::Odometry>::SharedPtr> odom_subs_;
  rclcpp::Service<aeropact_interfaces::srv::SubmitOrder>::SharedPtr submit_srv_;
  rclcpp::Service<aeropact_interfaces::srv::RequestPickup>::SharedPtr pickup_srv_;
  rclcpp::Service<aeropact_interfaces::srv::ReserveBay>::SharedPtr bay_srv_;
  rclcpp::Service<aeropact_interfaces::srv::InjectFault>::SharedPtr fault_srv_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::depot

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::depot::DepotNode)
