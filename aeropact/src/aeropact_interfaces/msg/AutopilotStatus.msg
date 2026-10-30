# State of the link between the companion computer and the vehicle's autopilot (flight
# controller), published by the vehicle interface (aeropact_px4). Autopilot-agnostic: only the
# fields the fleet stack and operators need. Absent on backends without an autopilot.
uint8 LINK_DISCONNECTED=0         # no autopilot telemetry
uint8 LINK_STANDBY=1              # disarmed, not asked to fly
uint8 LINK_ARMING=2               # switching to companion control and arming
uint8 LINK_OFFBOARD=3             # the fleet stack flies the vehicle
uint8 LINK_AUTOPILOT_OVERRIDE=4   # the autopilot (its failsafe, a pilot, a GCS) took over
uint8 LINK_DISARMING=5            # landing / disarming on request
uint8 LINK_TERMINATED=6           # flight termination

std_msgs/Header header
string drone_id
uint8 link_state
string reason
bool connected
bool armed
bool landed
bool failsafe                     # the autopilot's own failsafe is active
bool preflight_ok
uint8 nav_state                   # autopilot-specific mode number, for logs
string nav_state_name
bool position_valid               # global position estimate usable for control
float32 eph_m                     # horizontal position accuracy estimate
float32 epv_m                     # vertical position accuracy estimate
float32 autopilot_battery         # battery remaining as reported by the autopilot (0..1, -1 n/a)
uint32 arm_attempts
uint32 commands_rejected          # vehicle commands NACKed by the autopilot since start
