# An observer verdict about a peer, used for the failure quorum.
uint8 LEVEL_SUSPECT=1
uint8 LEVEL_UNREACHABLE=2
string observer
string target
uint8 level
float64 last_heard_age_s
geometry_msgs/Point last_position
float32 last_soc
bool physical_evidence            # last telemetry showed descent, failure or depleted battery
