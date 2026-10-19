# Delta-state gossip: only entries changed since the last exchange with the receiver.
uint64 replica_version            # sender replica version after this delta
bool full_sync                    # true for periodic anti-entropy (full state)
TaskRecord[] tasks
DroneState[] drones
PadReservation[] pad_adds
string[] pad_removes              # removed OR-set tags
ShardLease[] shard_leases
