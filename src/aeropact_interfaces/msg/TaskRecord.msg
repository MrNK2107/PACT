# One delivery job as replicated in every fleet replica (PRD 9.1).
#
# Merge is a join on a product lattice (docs/DESIGN.md, "Task merge"):
#   * `epoch` merges by max (fencing high-water mark, invariant I2);
#   * every other field comes from the winning version, ordered by
#     (progress class, claim_epoch, state rank, bid, lower owner id, lease_seq, state code),
#     where the progress class is 0 before pickup, 1 picked up, 2 aborted, 3 delivered.
# A picked-up parcel therefore outranks any concurrent re-open (point of no return), and
# terminal states are absorbing.

uint8 STATE_UNASSIGNED=0
uint8 STATE_CLAIMED=1
uint8 STATE_COMMITTED=2
uint8 STATE_PICKED_UP=3
uint8 STATE_ABORTED=4
uint8 STATE_DELIVERED=5

string task_id                    # "<depot>:<hlc>:<nonce>"
string origin_depot
geometry_msgs/Point pickup        # hand-off bay of the origin depot (world ENU, m)
geometry_msgs/Point drop          # drop point (world ENU, m)
uint8 priority                    # 1 urgent .. 3 low
float64 deadline                  # fleet time base (s), set at intake
float32 weight_kg
string shard                      # hex cell id "H-q-r" of the drop point
uint8 state
uint32 epoch                      # fencing high-water mark, monotonic per task (I2)
uint32 claim_epoch                # epoch at which the current version was written (fencing token)
string owner                      # empty when unowned
float64 bid
float64 lease_ttl                 # s, measured on the owner local monotonic clock
uint32 lease_seq                  # renewal counter within an epoch
float64 created_at
string replaces                   # task id this one re-orders (lost in flight), else empty
string abort_reason
