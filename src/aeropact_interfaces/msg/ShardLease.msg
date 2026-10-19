# Right to claim new tasks originating in a shard. LWW by (shard_id, epoch, lease_seq, holder).
string shard_id
string holder
uint32 epoch
uint32 lease_seq
float64 lease_ttl
