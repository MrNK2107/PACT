std_msgs/Header header
string drone_id
uint8 mode                        # DroneState.MODE_*
uint8 activity                    # DroneState.ACTIVITY_*
string partition_policy
string allocation_mode
string[] bundle
string current_task
uint32 replica_tasks
uint64 replica_version
uint64 task_digest                # equal digests == identical task state (convergence, I6)
PeerInfo[] peers
uint32 reachable_members
uint32 known_members
uint64 frames_sent
uint64 frames_received
float64 local_clock
float64 clock_drift_ppm
