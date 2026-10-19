uint8 ACTION_NOMINAL=0
uint8 ACTION_AVOID=1
uint8 ACTION_HOLD=2
uint8 ACTION_RTL=3
uint8 ACTION_LAND_NEAREST=4
uint8 ACTION_LAND_NOW=5
uint8 ACTION_DISARMED=6

std_msgs/Header header
string drone_id
uint8 action
string reason
bool veto_active                  # mission commands are currently overridden
bool armed
float32 soc
float32 min_separation_m          # closest sensed aircraft, large when none
bool geofence_ok
bool command_fresh                # mission layer watchdog
