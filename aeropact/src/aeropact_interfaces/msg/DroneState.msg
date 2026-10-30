# Gossiped drone status (PRD 9.1). LWW by (drone_id, seq).

uint8 HEALTH_OK=0
uint8 HEALTH_DEGRADED=1
uint8 HEALTH_FAILED=2

uint8 MODE_CONNECTED=0
uint8 MODE_DEGRADED=1
uint8 MODE_PARTITIONED=2
uint8 MODE_SOLO=3

uint8 ACTIVITY_IDLE=0
uint8 ACTIVITY_TO_PICKUP=1
uint8 ACTIVITY_LOADING=2
uint8 ACTIVITY_TO_DROP=3
uint8 ACTIVITY_DROPPING=4
uint8 ACTIVITY_TO_PAD=5
uint8 ACTIVITY_CHARGING=6
uint8 ACTIVITY_HOLDING=7
uint8 ACTIVITY_SAFETY_OVERRIDE=8
uint8 ACTIVITY_LANDED=9

string drone_id
uint64 seq
geometry_msgs/Point position
geometry_msgs/Vector3 velocity
float32 soc                       # 0..1
float32 capacity_kg
uint8 health
uint8 mode
uint8 activity
string[] bundle
string[] known_peers
float64 t_local
