# Liveness beacon. Also acknowledges lease renewals observed since the previous heartbeat,
# which owners use to confirm their leases (zombie-stop, invariant I3).
string node_id
uint64 seq
bool is_depot
geometry_msgs/Point position
float32 soc
uint8 health
float64 max_endurance_s           # upper bound on remaining flight time (physical failure bound)
string[] ack_task_ids
uint32[] ack_epochs
uint32[] ack_lease_seqs
string[] ack_shard_ids
uint32[] ack_shard_epochs
uint32[] ack_shard_lease_seqs
