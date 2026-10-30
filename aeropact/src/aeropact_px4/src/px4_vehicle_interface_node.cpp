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
#include <limits>
#include <memory>
#include <string>
#include <vector>

#include "aeropact_interfaces/msg/autopilot_status.hpp"
#include "aeropact_interfaces/msg/fleet_event.hpp"
#include "aeropact_interfaces/msg/payload_event.hpp"
#include "aeropact_px4/frames.hpp"
#include "aeropact_px4/offboard_arbiter.hpp"
#include "geometry_msgs/msg/twist.hpp"
#include "nav_msgs/msg/odometry.hpp"
#include "px4_msgs/msg/battery_status.hpp"
#include "px4_msgs/msg/offboard_control_mode.hpp"
#include "px4_msgs/msg/trajectory_setpoint.hpp"
#include "px4_msgs/msg/vehicle_attitude.hpp"
#include "px4_msgs/msg/vehicle_command.hpp"
#include "px4_msgs/msg/vehicle_command_ack.hpp"
#include "px4_msgs/msg/vehicle_global_position.hpp"
#include "px4_msgs/msg/vehicle_land_detected.hpp"
#include "px4_msgs/msg/vehicle_local_position.hpp"
#include "px4_msgs/msg/vehicle_status.hpp"
#include "rclcpp/rclcpp.hpp"
#include "rclcpp_components/register_node_macro.hpp"
#include "rclcpp_lifecycle/lifecycle_node.hpp"
#include "sensor_msgs/msg/battery_state.hpp"
#include "std_msgs/msg/bool.hpp"

namespace aeropact::px4
{

using CallbackReturn = rclcpp_lifecycle::node_interfaces::LifecycleNodeInterface::CallbackReturn;
using AutopilotStatus = aeropact_interfaces::msg::AutopilotStatus;
using px4_msgs::msg::VehicleCommand;
using px4_msgs::msg::VehicleStatus;

namespace
{

const char * nav_state_name(uint8_t s)
{
  switch (s) {
    case VehicleStatus::NAVIGATION_STATE_MANUAL: return "MANUAL";
    case VehicleStatus::NAVIGATION_STATE_ALTCTL: return "ALTCTL";
    case VehicleStatus::NAVIGATION_STATE_POSCTL: return "POSCTL";
    case VehicleStatus::NAVIGATION_STATE_AUTO_MISSION: return "AUTO_MISSION";
    case VehicleStatus::NAVIGATION_STATE_AUTO_LOITER: return "AUTO_LOITER";
    case VehicleStatus::NAVIGATION_STATE_AUTO_RTL: return "AUTO_RTL";
    case VehicleStatus::NAVIGATION_STATE_DESCEND: return "DESCEND";
    case VehicleStatus::NAVIGATION_STATE_TERMINATION: return "TERMINATION";
    case VehicleStatus::NAVIGATION_STATE_OFFBOARD: return "OFFBOARD";
    case VehicleStatus::NAVIGATION_STATE_STAB: return "STAB";
    case VehicleStatus::NAVIGATION_STATE_AUTO_TAKEOFF: return "AUTO_TAKEOFF";
    case VehicleStatus::NAVIGATION_STATE_AUTO_LAND: return "AUTO_LAND";
    case VehicleStatus::NAVIGATION_STATE_AUTO_PRECLAND: return "AUTO_PRECLAND";
    default: return "OTHER";
  }
}

uint8_t link_state_msg(LinkState s)
{
  return static_cast<uint8_t>(s);  // values match AutopilotStatus LINK_*
}

}  // namespace

/**
 * Vehicle interface between the fleet stack and a PX4 autopilot over uXRCE-DDS.
 *
 * Runs on the vehicle's companion computer, one per vehicle, in the vehicle namespace. The same
 * component drives PX4 SITL and a real flight controller connected over serial or Ethernet: only
 * the Micro XRCE-DDS Agent's transport differs.
 *
 * Fleet side (the interface every other backend provides):
 *   in   cmd_vel (geometry_msgs/Twist, heading frame, from the safety supervisor), enable (Bool)
 *   out  odom (nav_msgs/Odometry, site ENU frame from PX4's global estimate), autopilot/status,
 *        battery (optional: when the autopilot's battery monitor is the source of truth)
 * PX4 side (<px4_namespace>/fmu/...):
 *   in   vehicle_status, vehicle_global_position, vehicle_local_position, vehicle_attitude,
 *        vehicle_land_detected, vehicle_command_ack, battery_status
 *   out  offboard_control_mode + trajectory_setpoint (velocity, streamed), vehicle_command
 *
 * Arming and mode changes go through OffboardArbiter (never fights the autopilot's failsafes).
 */
class Px4VehicleInterfaceNode : public rclcpp_lifecycle::LifecycleNode
{
public:
  explicit Px4VehicleInterfaceNode(const rclcpp::NodeOptions & options)
  : rclcpp_lifecycle::LifecycleNode("vehicle_interface", options)
  {
    declare_parameter("drone_id", "A01");
    declare_parameter("geodetic_origin", std::vector<double>{});  // [lat_deg, lon_deg, alt_m]
    declare_parameter("fmu_prefix", "fmu");  // PX4_UXRCE_DDS_NS puts it under the vehicle ns
    declare_parameter("status_topic_suffix", "_v1");  // VehicleStatus is message version 1
    declare_parameter("setpoint_rate_hz", 20.0);
    declare_parameter("link_timeout_s", 1.0);
    declare_parameter("command_timeout_s", 0.5);
    declare_parameter("stream_before_switch_s", 1.0);
    declare_parameter("retry_period_s", 1.0);
    declare_parameter("max_arm_attempts", 15);
    declare_parameter("publish_battery", false);
    declare_parameter("termination_topic", "sim/motor_cut");
    declare_parameter("frame_id", "map");
    // Payload release mechanism commanded through the autopilot: gripper (DO_GRIPPER), winch
    // (DO_WINCH) or none. Hand-off and release events come from the coordinator.
    declare_parameter("payload_mechanism", "gripper");
    declare_parameter("payload_topic", "/sim/payload");
  }

  CallbackReturn on_configure(const rclcpp_lifecycle::State &) override
  {
    drone_id_ = get_parameter("drone_id").as_string();
    const auto origin = get_parameter("geodetic_origin").as_double_array();
    if (origin.size() != 3) {
      RCLCPP_ERROR(get_logger(), "geodetic_origin must be [lat_deg, lon_deg, alt_m]");
      return CallbackReturn::FAILURE;
    }
    ltp_ = LocalTangentPlane({origin[0], origin[1], origin[2]});
    ArbiterConfig ac;
    ac.stream_before_switch_s = get_parameter("stream_before_switch_s").as_double();
    ac.retry_period_s = get_parameter("retry_period_s").as_double();
    ac.max_arm_attempts = static_cast<int>(get_parameter("max_arm_attempts").as_int());
    arbiter_ = OffboardArbiter(ac);
    link_timeout_ = get_parameter("link_timeout_s").as_double();
    command_timeout_ = get_parameter("command_timeout_s").as_double();
    frame_id_ = get_parameter("frame_id").as_string();

    const std::string fmu = get_parameter("fmu_prefix").as_string();
    const auto px4_qos = rclcpp::QoS(rclcpp::KeepLast(5)).best_effort().durability_volatile();
    status_sub_ = create_subscription<VehicleStatus>(
      fmu + "/out/vehicle_status" + get_parameter("status_topic_suffix").as_string(), px4_qos,
      [this](VehicleStatus::ConstSharedPtr m) {
        status_ = *m;
        status_stamp_ = now().seconds();
      });
    global_sub_ = create_subscription<px4_msgs::msg::VehicleGlobalPosition>(
      fmu + "/out/vehicle_global_position", px4_qos,
      [this](px4_msgs::msg::VehicleGlobalPosition::ConstSharedPtr m) {
        global_ = *m;
        have_global_ = true;
                            });
    local_sub_ = create_subscription<px4_msgs::msg::VehicleLocalPosition>(
      fmu + "/out/vehicle_local_position", px4_qos,
      [this](px4_msgs::msg::VehicleLocalPosition::ConstSharedPtr m) {
        local_ = *m;
        have_local_ = true;
        publish_odometry();
      });
    attitude_sub_ = create_subscription<px4_msgs::msg::VehicleAttitude>(
      fmu + "/out/vehicle_attitude", px4_qos,
      [this](px4_msgs::msg::VehicleAttitude::ConstSharedPtr m) {
        attitude_ = {m->q[0], m->q[1], m->q[2], m->q[3]};
        have_attitude_ = true;
      });
    land_sub_ = create_subscription<px4_msgs::msg::VehicleLandDetected>(
      fmu + "/out/vehicle_land_detected", px4_qos,
      [this](px4_msgs::msg::VehicleLandDetected::ConstSharedPtr m) {landed_ = m->landed;});
    ack_sub_ = create_subscription<px4_msgs::msg::VehicleCommandAck>(
      fmu + "/out/vehicle_command_ack", px4_qos,
      [this](px4_msgs::msg::VehicleCommandAck::ConstSharedPtr m) {on_ack(*m);});
    battery_sub_ = create_subscription<px4_msgs::msg::BatteryStatus>(
      fmu + "/out/battery_status", px4_qos,
      [this](px4_msgs::msg::BatteryStatus::ConstSharedPtr m) {on_battery(*m);});

    offboard_pub_ = create_publisher<px4_msgs::msg::OffboardControlMode>(
      fmu + "/in/offboard_control_mode", rclcpp::QoS(5));
    setpoint_pub_ = create_publisher<px4_msgs::msg::TrajectorySetpoint>(
      fmu + "/in/trajectory_setpoint", rclcpp::QoS(5));
    command_pub_ = create_publisher<VehicleCommand>(fmu + "/in/vehicle_command", rclcpp::QoS(10));

    cmd_sub_ = create_subscription<geometry_msgs::msg::Twist>(
      "cmd_vel", rclcpp::QoS(5), [this](geometry_msgs::msg::Twist::ConstSharedPtr m) {
        cmd_ = *m;
        cmd_stamp_ = now().seconds();
      });
    enable_sub_ = create_subscription<std_msgs::msg::Bool>(
      "enable", rclcpp::QoS(5), [this](std_msgs::msg::Bool::ConstSharedPtr m) {
        arbiter_.set_enable(m->data, now().seconds());
      });
    const auto term_topic = get_parameter("termination_topic").as_string();
    if (!term_topic.empty()) {
      term_sub_ = create_subscription<std_msgs::msg::Bool>(
        term_topic, rclcpp::QoS(5), [this](std_msgs::msg::Bool::ConstSharedPtr m) {
          if (m->data && !termination_requested_) {
            termination_requested_ = true;
            arbiter_.request_termination();
            emit("AUTOPILOT_TERMINATION_REQUESTED", "{}");
          }
        });
    }
    payload_mechanism_ = get_parameter("payload_mechanism").as_string();
    if (payload_mechanism_ != "gripper" && payload_mechanism_ != "winch" &&
      payload_mechanism_ != "none")
    {
      RCLCPP_ERROR(get_logger(), "payload_mechanism must be gripper, winch or none");
      return CallbackReturn::FAILURE;
    }
    if (payload_mechanism_ != "none") {
      payload_sub_ = create_subscription<aeropact_interfaces::msg::PayloadEvent>(
        get_parameter("payload_topic").as_string(), rclcpp::QoS(50).reliable(),
        [this](aeropact_interfaces::msg::PayloadEvent::ConstSharedPtr m) {
          if (m->drone_id == drone_id_) {
            command_payload(m->attached, m->task_id);
          }
        });
    }

    odom_pub_ = create_publisher<nav_msgs::msg::Odometry>("odom", rclcpp::SensorDataQoS());
    status_pub_ = create_publisher<AutopilotStatus>("autopilot/status", rclcpp::QoS(5));
    if (get_parameter("publish_battery").as_bool()) {
      battery_pub_ = create_publisher<sensor_msgs::msg::BatteryState>("battery", rclcpp::QoS(5));
    }
    event_pub_ = create_publisher<aeropact_interfaces::msg::FleetEvent>(
      "/fleet/events", rclcpp::QoS(200).reliable());
    RCLCPP_INFO(get_logger(), "%s: PX4 vehicle interface on %s, site origin %.7f %.7f %.1f",
      drone_id_.c_str(), (std::string(get_namespace()) + "/" + fmu).c_str(), origin[0], origin[1],
      origin[2]);
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_activate(const rclcpp_lifecycle::State &) override
  {
    offboard_pub_->on_activate();
    setpoint_pub_->on_activate();
    command_pub_->on_activate();
    odom_pub_->on_activate();
    status_pub_->on_activate();
    event_pub_->on_activate();
    if (battery_pub_) {
      battery_pub_->on_activate();
    }
    const double hz = get_parameter("setpoint_rate_hz").as_double();
    timer_ = rclcpp::create_timer(this, get_clock(), rclcpp::Duration::from_seconds(1.0 / hz),
        [this]() {step();});
    active_ = true;
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_deactivate(const rclcpp_lifecycle::State &) override
  {
    // Stop streaming: PX4's offboard-loss failsafe takes over, as it must when the companion
    // computer's software stops.
    active_ = false;
    if (timer_) {
      timer_->cancel();
    }
    offboard_pub_->on_deactivate();
    setpoint_pub_->on_deactivate();
    command_pub_->on_deactivate();
    odom_pub_->on_deactivate();
    status_pub_->on_deactivate();
    event_pub_->on_deactivate();
    if (battery_pub_) {
      battery_pub_->on_deactivate();
    }
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_cleanup(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    status_sub_.reset();
    global_sub_.reset();
    local_sub_.reset();
    attitude_sub_.reset();
    land_sub_.reset();
    ack_sub_.reset();
    battery_sub_.reset();
    cmd_sub_.reset();
    enable_sub_.reset();
    term_sub_.reset();
    payload_sub_.reset();
    return CallbackReturn::SUCCESS;
  }

  CallbackReturn on_shutdown(const rclcpp_lifecycle::State &) override
  {
    timer_.reset();
    return CallbackReturn::SUCCESS;
  }

private:
  uint64_t stamp_us() const
  {
    return static_cast<uint64_t>(now().nanoseconds() / 1000);
  }

  AutopilotState autopilot_state() const
  {
    AutopilotState s;
    s.connected = now().seconds() - status_stamp_ < link_timeout_;
    s.armed = status_.arming_state == VehicleStatus::ARMING_STATE_ARMED;
    s.offboard = status_.nav_state == VehicleStatus::NAVIGATION_STATE_OFFBOARD;
    s.failsafe = status_.failsafe;
    s.preflight_ok = status_.pre_flight_checks_pass;
    s.terminated = status_.nav_state == VehicleStatus::NAVIGATION_STATE_TERMINATION;
    s.landed = landed_;
    return s;
  }

  void step()
  {
    if (!active_) {
      return;
    }
    const double t = now().seconds();
    const AutopilotState s = autopilot_state();
    for (const CommandType c : arbiter_.step(t, s)) {
      send_command(c);
    }
    if (arbiter_.state() != last_state_) {
      emit("AUTOPILOT_LINK", std::string("{\"from\":\"") + to_string(last_state_) +
        "\",\"to\":\"" + to_string(arbiter_.state()) + "\",\"reason\":\"" + arbiter_.reason() +
        "\",\"nav_state\":\"" + nav_state_name(status_.nav_state) + "\",\"armed\":" +
        (s.armed ? "true" : "false") + "}");
      RCLCPP_INFO(get_logger(), "%s: autopilot link %s -> %s (%s, nav %s)", drone_id_.c_str(),
        to_string(last_state_), to_string(arbiter_.state()), arbiter_.reason().c_str(),
        nav_state_name(status_.nav_state));
      last_state_ = arbiter_.state();
    }
    if (s.connected) {
      stream_setpoint(t);
    }
    if (t - last_status_pub_ >= 0.2) {
      last_status_pub_ = t;
      publish_status(s);
    }
  }

  void stream_setpoint(double t)
  {
    px4_msgs::msg::OffboardControlMode mode;
    mode.timestamp = stamp_us();
    mode.velocity = true;
    offboard_pub_->publish(mode);

    // Heading frame (yaw-only body frame of the odometry we publish) -> site ENU -> NED.
    Vec3d v_enu{0.0, 0.0, 0.0};
    double yaw_rate_enu = 0.0;
    if (arbiter_.forward_velocity() && t - cmd_stamp_ <= command_timeout_) {
      v_enu = heading_to_world({cmd_.linear.x, cmd_.linear.y, cmd_.linear.z}, yaw_enu_);
      yaw_rate_enu = cmd_.angular.z;
    }
    const Vec3d v_ned = enu_to_ned(v_enu);
    const float nan = std::numeric_limits<float>::quiet_NaN();
    px4_msgs::msg::TrajectorySetpoint sp;
    sp.timestamp = mode.timestamp;
    sp.position = {nan, nan, nan};
    sp.velocity = {static_cast<float>(v_ned.x), static_cast<float>(v_ned.y),
      static_cast<float>(v_ned.z)};
    sp.acceleration = {nan, nan, nan};
    sp.jerk = {nan, nan, nan};
    sp.yaw = nan;
    sp.yawspeed = static_cast<float>(-yaw_rate_enu);  // ENU counter-clockwise -> NED clockwise
    setpoint_pub_->publish(sp);
  }

  void send_command(CommandType c)
  {
    VehicleCommand cmd;
    cmd.timestamp = stamp_us();
    cmd.target_system = status_.system_id;
    cmd.target_component = 1;
    cmd.source_system = 1;
    cmd.source_component = 1;
    cmd.from_external = true;
    switch (c) {
      case CommandType::kSetOffboard:
        cmd.command = VehicleCommand::VEHICLE_CMD_DO_SET_MODE;
        cmd.param1 = 1.0f;  // custom mode
        cmd.param2 = 6.0f;  // PX4 main mode OFFBOARD
        break;
      case CommandType::kArm:
        cmd.command = VehicleCommand::VEHICLE_CMD_COMPONENT_ARM_DISARM;
        cmd.param1 = 1.0f;
        break;
      case CommandType::kDisarm:
        cmd.command = VehicleCommand::VEHICLE_CMD_COMPONENT_ARM_DISARM;
        cmd.param1 = 0.0f;
        break;
      case CommandType::kLand:
        cmd.command = VehicleCommand::VEHICLE_CMD_NAV_LAND;
        break;
      case CommandType::kTerminate:
        cmd.command = VehicleCommand::VEHICLE_CMD_DO_FLIGHTTERMINATION;
        cmd.param1 = 1.0f;
        break;
    }
    command_pub_->publish(cmd);
    RCLCPP_DEBUG(get_logger(), "%s: command %s", drone_id_.c_str(), to_string(c));
  }

  /// Grab on hand-off, release at the drop point, through the autopilot's payload module.
  void command_payload(bool attach, const std::string & task_id)
  {
    if (!active_) {
      return;
    }
    VehicleCommand cmd;
    cmd.timestamp = stamp_us();
    cmd.target_system = status_.system_id;
    cmd.target_component = 1;
    cmd.source_system = 1;
    cmd.source_component = 1;
    cmd.from_external = true;
    cmd.param1 = 1.0f;  // mechanism instance
    if (payload_mechanism_ == "gripper") {
      cmd.command = VehicleCommand::VEHICLE_CMD_DO_GRIPPER;
      cmd.param2 = static_cast<float>(attach ? VehicleCommand::GRIPPER_ACTION_GRAB :
        VehicleCommand::GRIPPER_ACTION_RELEASE);
    } else {
      cmd.command = VehicleCommand::VEHICLE_CMD_DO_WINCH;
      cmd.param2 = attach ? 9.0f : 4.0f;  // MAVLink WINCH_LOAD_PAYLOAD / WINCH_DELIVER
    }
    command_pub_->publish(cmd);
    payload_command_ = cmd.command;
    payload_sent_ = now().seconds();
    payload_task_ = task_id;
    payload_attach_ = attach;
    emit("PAYLOAD_COMMANDED", "{\"task_id\":\"" + task_id + "\",\"action\":\"" +
      (attach ? "grab" : "release") + "\",\"mechanism\":\"" + payload_mechanism_ + "\"}");
  }

  void on_ack(const px4_msgs::msg::VehicleCommandAck & a)
  {
    if (payload_command_ != 0 && a.command == payload_command_ &&
      a.result != px4_msgs::msg::VehicleCommandAck::VEHICLE_CMD_RESULT_IN_PROGRESS)
    {
      const bool ok = a.result == px4_msgs::msg::VehicleCommandAck::VEHICLE_CMD_RESULT_ACCEPTED;
      emit(ok ? "PAYLOAD_ACTUATED" : "PAYLOAD_FAULT", "{\"task_id\":\"" + payload_task_ +
        "\",\"action\":\"" + (payload_attach_ ? "grab" : "release") + "\",\"result\":" +
        std::to_string(a.result) + ",\"latency_s\":" +
        std::to_string(now().seconds() - payload_sent_) + "}");
      payload_command_ = 0;
    }
    if (a.result == px4_msgs::msg::VehicleCommandAck::VEHICLE_CMD_RESULT_ACCEPTED ||
      a.result == px4_msgs::msg::VehicleCommandAck::VEHICLE_CMD_RESULT_IN_PROGRESS)
    {
      return;
    }
    ++commands_rejected_;
    if (now().seconds() - last_reject_log_ > 5.0) {
      last_reject_log_ = now().seconds();
      RCLCPP_WARN(get_logger(), "%s: autopilot rejected command %u (result %u)", drone_id_.c_str(),
        a.command, a.result);
      emit("AUTOPILOT_COMMAND_REJECTED", "{\"command\":" + std::to_string(a.command) +
        ",\"result\":" + std::to_string(a.result) + "}");
    }
  }

  void on_battery(const px4_msgs::msg::BatteryStatus & b)
  {
    autopilot_battery_ = b.connected ? b.remaining : -1.0f;
    if (!battery_pub_ || !b.connected) {
      return;
    }
    sensor_msgs::msg::BatteryState m;
    m.header.stamp = now();
    m.percentage = b.remaining;
    m.voltage = b.voltage_v;
    m.current = -b.current_a;
    m.present = true;
    m.power_supply_status = sensor_msgs::msg::BatteryState::POWER_SUPPLY_STATUS_DISCHARGING;
    battery_pub_->publish(m);
  }

  void publish_odometry()
  {
    if (!active_ || !have_global_ || !have_attitude_ || !global_.lat_lon_valid ||
      !global_.alt_valid || !local_.v_xy_valid || !local_.v_z_valid)
    {
      return;
    }
    // Position from the global estimate on the site's WGS84 tangent plane (D-23); velocity from
    // the local estimate (true metres per second, frame-independent up to the NED->ENU swap).
    const Vec3d p = ltp_.to_enu({global_.lat, global_.lon, global_.alt});
    const Vec3d v = ned_to_enu({local_.vx, local_.vy, local_.vz});
    const Quat q = attitude_ned_frd_to_enu_flu(attitude_);
    double roll = 0.0;
    double pitch = 0.0;
    quat_to_rpy(q, roll, pitch, yaw_enu_);
    // Twist in the heading frame, like the other backends' odometry consumers expect.
    const Vec3d vh = world_to_heading(v, yaw_enu_);

    nav_msgs::msg::Odometry o;
    o.header.stamp = now();
    o.header.frame_id = frame_id_;
    o.child_frame_id = drone_id_ + "/base_link";
    o.pose.pose.position.x = p.x;
    o.pose.pose.position.y = p.y;
    o.pose.pose.position.z = p.z;
    o.pose.pose.orientation.w = q[0];
    o.pose.pose.orientation.x = q[1];
    o.pose.pose.orientation.y = q[2];
    o.pose.pose.orientation.z = q[3];
    const double eph2 = static_cast<double>(global_.eph) * global_.eph;
    const double epv2 = static_cast<double>(global_.epv) * global_.epv;
    o.pose.covariance[0] = eph2;
    o.pose.covariance[7] = eph2;
    o.pose.covariance[14] = epv2;
    o.twist.twist.linear.x = vh.x;
    o.twist.twist.linear.y = vh.y;
    o.twist.twist.linear.z = vh.z;
    odom_pub_->publish(o);
  }

  void publish_status(const AutopilotState & s)
  {
    AutopilotStatus m;
    m.header.stamp = now();
    m.drone_id = drone_id_;
    m.link_state = link_state_msg(arbiter_.state());
    m.reason = arbiter_.reason();
    m.connected = s.connected;
    m.armed = s.armed;
    m.landed = s.landed;
    m.failsafe = s.failsafe;
    m.preflight_ok = s.preflight_ok;
    m.nav_state = status_.nav_state;
    m.nav_state_name = nav_state_name(status_.nav_state);
    m.position_valid = have_global_ && global_.lat_lon_valid && global_.alt_valid;
    m.eph_m = global_.eph;
    m.epv_m = global_.epv;
    m.autopilot_battery = autopilot_battery_;
    m.arm_attempts = static_cast<uint32_t>(arbiter_.arm_attempts());
    m.commands_rejected = commands_rejected_;
    status_pub_->publish(m);
  }

  void emit(const std::string & type, const std::string & data)
  {
    aeropact_interfaces::msg::FleetEvent ev;
    ev.stamp = now();
    ev.agent = drone_id_;
    ev.type = type;
    ev.data = data;
    event_pub_->publish(ev);
  }

  std::string drone_id_;
  std::string frame_id_;
  LocalTangentPlane ltp_;
  OffboardArbiter arbiter_;
  LinkState last_state_{LinkState::kDisconnected};
  double link_timeout_{1.0};
  double command_timeout_{0.5};
  bool active_{false};
  bool termination_requested_{false};

  VehicleStatus status_;
  double status_stamp_{-1e9};
  px4_msgs::msg::VehicleGlobalPosition global_;
  px4_msgs::msg::VehicleLocalPosition local_;
  bool have_global_{false};
  bool have_local_{false};
  Quat attitude_{1.0, 0.0, 0.0, 0.0};
  bool have_attitude_{false};
  bool landed_{true};
  double yaw_enu_{0.0};
  float autopilot_battery_{-1.0f};
  uint32_t commands_rejected_{0};
  double last_reject_log_{-1e9};
  geometry_msgs::msg::Twist cmd_;
  double cmd_stamp_{-1e9};
  double last_status_pub_{-1e9};

  rclcpp::Subscription<VehicleStatus>::SharedPtr status_sub_;
  rclcpp::Subscription<px4_msgs::msg::VehicleGlobalPosition>::SharedPtr global_sub_;
  rclcpp::Subscription<px4_msgs::msg::VehicleLocalPosition>::SharedPtr local_sub_;
  rclcpp::Subscription<px4_msgs::msg::VehicleAttitude>::SharedPtr attitude_sub_;
  rclcpp::Subscription<px4_msgs::msg::VehicleLandDetected>::SharedPtr land_sub_;
  rclcpp::Subscription<px4_msgs::msg::VehicleCommandAck>::SharedPtr ack_sub_;
  rclcpp::Subscription<px4_msgs::msg::BatteryStatus>::SharedPtr battery_sub_;
  rclcpp::Subscription<geometry_msgs::msg::Twist>::SharedPtr cmd_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr enable_sub_;
  rclcpp::Subscription<std_msgs::msg::Bool>::SharedPtr term_sub_;
  rclcpp::Subscription<aeropact_interfaces::msg::PayloadEvent>::SharedPtr payload_sub_;
  std::string payload_mechanism_;
  uint32_t payload_command_{0};
  double payload_sent_{-1e9};
  std::string payload_task_;
  bool payload_attach_{false};
  rclcpp_lifecycle::LifecyclePublisher<px4_msgs::msg::OffboardControlMode>::SharedPtr
    offboard_pub_;
  rclcpp_lifecycle::LifecyclePublisher<px4_msgs::msg::TrajectorySetpoint>::SharedPtr
    setpoint_pub_;
  rclcpp_lifecycle::LifecyclePublisher<VehicleCommand>::SharedPtr command_pub_;
  rclcpp_lifecycle::LifecyclePublisher<nav_msgs::msg::Odometry>::SharedPtr odom_pub_;
  rclcpp_lifecycle::LifecyclePublisher<AutopilotStatus>::SharedPtr status_pub_;
  rclcpp_lifecycle::LifecyclePublisher<sensor_msgs::msg::BatteryState>::SharedPtr battery_pub_;
  rclcpp_lifecycle::LifecyclePublisher<aeropact_interfaces::msg::FleetEvent>::SharedPtr
    event_pub_;
  rclcpp::TimerBase::SharedPtr timer_;
};

}  // namespace aeropact::px4

RCLCPP_COMPONENTS_REGISTER_NODE(aeropact::px4::Px4VehicleInterfaceNode)
