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

#ifndef AEROPACT_AGENT__CONVERSIONS_HPP_
#define AEROPACT_AGENT__CONVERSIONS_HPP_

#include "aeropact_core/replica.hpp"
#include "aeropact_core/types.hpp"
#include "aeropact_interfaces/msg/drone_state.hpp"
#include "aeropact_interfaces/msg/gossip_delta.hpp"
#include "aeropact_interfaces/msg/pad_reservation.hpp"
#include "aeropact_interfaces/msg/shard_lease.hpp"
#include "aeropact_interfaces/msg/task_record.hpp"
#include "geometry_msgs/msg/point.hpp"
#include "geometry_msgs/msg/vector3.hpp"

namespace aeropact::agent
{

namespace msg = aeropact_interfaces::msg;

geometry_msgs::msg::Point to_point(const core::Vec3 & v);
geometry_msgs::msg::Vector3 to_vector3(const core::Vec3 & v);
core::Vec3 from_msg(const geometry_msgs::msg::Point & p);
core::Vec3 from_msg(const geometry_msgs::msg::Vector3 & v);

msg::TaskRecord to_msg(const core::Task & t);
core::Task from_msg(const msg::TaskRecord & m);

msg::DroneState to_msg(const core::DroneInfo & d);
core::DroneInfo from_msg(const msg::DroneState & m);

msg::PadReservation to_msg(const core::PadReservation & r);
core::PadReservation from_msg(const msg::PadReservation & m);

msg::ShardLease to_msg(const core::ShardLease & l);
core::ShardLease from_msg(const msg::ShardLease & m);

msg::GossipDelta to_msg(const core::Delta & d);
core::Delta from_msg(const msg::GossipDelta & m);

}  // namespace aeropact::agent

#endif  // AEROPACT_AGENT__CONVERSIONS_HPP_
