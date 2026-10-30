/**
 * Shared contracts of the P2P layer (docs/P2P_DESIGN.md). Types only: implementations live in src/net (environment
 * side) and src/p2p (agent side). Changing a type here needs a note in docs/DECISIONS.md.
 */
import type { Priority, TaskState } from '../sim/Task';
import type { DropType, Vec3 } from '../world/types';

export type NodeId = string;

// ---- network (TC-02) ------------------------------------------------------------------------------------

export type MessageType =
  | 'HEARTBEAT'
  | 'CLAIM'
  | 'GOSSIP_DELTA'
  | 'GOSSIP_DIGEST'
  | 'PICKUP_REQ'
  | 'PICKUP_GRANT'
  | 'TASK_TAKEN'
  | 'SHARD_LEASE'
  | 'PROBE'
  | 'PROBE_ACK'
  | 'DISTRESS';

/** PRD 9.1 message envelope. `dst` is `'*'` for broadcast. Receivers ignore unknown fields (NFR-3). */
export interface Envelope<P = unknown> {
  v: 1;
  type: MessageType;
  src: NodeId;
  dst: NodeId | '*';
  /** Per-sender sequence number. */
  seq: number;
  /** Sender's local clock at send time. */
  t_send: number;
  payload: P;
}

/** What a node sees of the network: send now, receive what has arrived. Implemented by src/net/Network.ts. */
export interface NetworkPort {
  send(env: Omit<Envelope, 'v' | 'seq'>): void;
  receive(): Envelope[];
}

/** Monotonic local clock; may drift against simulation time. Agents read only this (PRD 9.2). */
export interface Clock {
  nowLocal(): number;
}

// ---- replicated state (TC-03) ---------------------------------------------------------------------------

/** Gossiped task record: PRD 9.1 fields + lease bookkeeping + immutable sim-side payload. */
export interface TaskRecord {
  task_id: string;
  origin_depot: string;
  pickup: Vec3;
  drop: Vec3;
  priority: Priority;
  deadline: number;
  weight_kg: number;
  shard: string;
  state: TaskState;
  epoch: number;
  owner: NodeId | null;
  bid: number | null;
  /** Lease renewal counter within the current epoch (merge tie-break; propagates renewals). */
  renew: number;
  /** Lease duration in seconds (durations travel, absolute times do not: clocks differ). */
  lease_s: number;
  created_at: number;
  // immutable sim-side payload (never part of the merge order)
  dropId: string;
  type: DropType;
  scripted: boolean;
  reorderOf?: string;
}

/** Merge key of a task record, compared lexicographically (docs/P2P_DESIGN.md section 4). */
export interface TaskKey {
  epoch: number;
  rank: number;
  /** null sorts after every id. */
  owner: NodeId | null;
  renew: number;
}

export type DroneMode = 'CONNECTED' | 'DEGRADED' | 'PARTITIONED' | 'SOLO';

/** PRD 9.1 DroneStatus, LWW by seq. */
export interface DroneStatusRecord {
  drone_id: NodeId;
  seq: number;
  pos: Vec3;
  soc: number;
  mode: DroneMode;
  /** Task ids the drone holds (bundle; B = 1 today). */
  bundle: string[];
  t_local: number;
  /**
   * Depot status only (integration): lease acknowledgements of the depot's own tasks, task id -> `[epoch, renew]` as
   * last seen by the origin depot. An owner counts a renewal as confirmed only from here (design section 6).
   */
  acks?: Record<string, [epoch: number, renew: number]>;
  /**
   * Drone status only (integration): peers this drone reports UNREACHABLE (no beacon and no gossiped status within
   * the reach window). Feeds the failure quorum of every receiver (TC-09).
   */
  suspects?: NodeId[];
  /**
   * Drone status only (TC-09 hardening): upper bound of the seconds the drone can still stay aloft on its current
   * energy (SOC over the minimum power draw). Physical evidence for the failure detector: silence cannot declare the
   * drone failed before this bound has passed (03 section 3.6).
   */
  endurance_s?: number;
}

/** Shard lease, LWW by (epoch, renew). Granted by the shard's catchment depot. */
export interface ShardLeaseRecord {
  shard: string;
  depot: NodeId;
  epoch: number;
  holder: NodeId | null;
  renew: number;
  lease_s: number;
}

export interface ReplicaDelta {
  tasks: TaskRecord[];
  status: DroneStatusRecord[];
  shards: ShardLeaseRecord[];
}

export interface ReplicaDigest {
  tasks: Record<string, TaskKey>;
  /** Optional (integration): a digest without `status` asks for no status anti-entropy (statuses refresh by push). */
  status?: Record<NodeId, number>;
  shards: Record<string, [epoch: number, renew: number]>;
}

/** Ids a node asks a peer for after comparing digests. */
export interface ReplicaWant {
  tasks: string[];
  status: NodeId[];
  shards: string[];
}

/** GOSSIP_DELTA payload: a ReplicaDelta plus an optional pull request. */
export interface GossipDeltaPayload extends ReplicaDelta {
  want?: ReplicaWant;
}

/** Outcome of merging one incoming task record. */
export type MergeOutcome = 'unchanged' | 'updated' | 'inserted';

// ---- ownership (TC-07) ----------------------------------------------------------------------------------

export type PartitionPolicyName = 'STRICT' | 'QUORUM' | 'OPTIMISTIC_BOUNDED';

/** What a policy may look at: a read-only view of the local replica plus connectivity estimates. */
export interface FleetView {
  readonly me: NodeId;
  nowLocal(): number;
  /** Drones (including me) whose status reached me within the reach window. Sorted. */
  reachable(): readonly NodeId[];
  /** Every drone id ever seen minus declared-failed ones (including me). Sorted. */
  knownFleet(): readonly NodeId[];
  /** Current shard lease in my replica, if any, and whether it is unexpired in my view. */
  shardLease(shard: string): { lease: ShardLeaseRecord; live: boolean } | null;
  /** Claims I currently hold that were made while QUORUM did not hold. */
  optimisticClaims(): number;
}

/** PRD 9.2 PartitionPolicy. */
export interface PartitionPolicy {
  readonly name: PartitionPolicyName;
  mayClaimNew(task: TaskRecord, view: FleetView): boolean;
}

/** Lease timing parameters (PRD section 15 defaults). */
export interface LeaseParams {
  leaseTtlS: number;
  tCommitS: number;
  driftMargin: number;
  graceS: number;
}

/** Shard-lease timing (holder lease, depot observer bound). */
export interface ShardLeaseParams {
  leaseS: number;
  driftMargin: number;
  graceS: number;
}

// ---- point-to-point payloads (integration: TC-07 / TC-08 / TC-09) -------------------------------------------

/** PICKUP_REQ (drone -> origin depot, unicast): the drone's record of the task and the epoch it claims to own. */
export interface PickupReqPayload {
  task: TaskRecord;
  epoch: number;
}

/** PICKUP_GRANT / TASK_TAKEN (depot -> drone, unicast): the depot's resulting record (merge, grant or fence). */
export interface PickupAnswerPayload {
  task_id: string;
  epoch: number;
  record: TaskRecord | null;
  reason?: string;
}

/**
 * SHARD_LEASE. Request (drone -> catchment depot): `shards` to acquire / renew, `handBack` leases returned.
 * Answer (depot -> drone): `leases` as the depot now has them and `t_req` = the request's `t_send` echoed, so the
 * holder times its lease from its own send time (`ShardLeaseHolder.onAnswer`).
 */
export interface ShardLeasePayload {
  shards?: string[];
  handBack?: ShardLeaseRecord[];
  leases?: ShardLeaseRecord[];
  t_req?: number;
}

export interface ProbePayload {
  target: NodeId;
}

export interface ProbeAckPayload {
  target: NodeId;
  alive: boolean;
  sinceS: number | null;
}

export interface DistressPayload {
  reason: string;
}

// ---- failure detection (TC-09)--------------------------------------------------------------------------

export type PeerHealth = 'ALIVE' | 'SUSPECT' | 'UNREACHABLE' | 'DECLARED_FAILED';

export interface FailureParams {
  phiSuspect: number;
  phiUnreachable: number;
  windowSize: number;
  minStdS: number;
  probeFanout: number;
  quorum: number;
  tFailedS: number;
}

// ---- defaults -------------------------------------------------------------------------------------------

export const P2P_DEFAULTS = {
  depotMastM: 25,
  tombstoneTtlS: 120,
  digestEvery: 5,
  gossipMinPeriodS: 0.25,
  gossipMaxFactor: 4,
  reachWindowS: 3,
  maxOptimistic: 1,
  shardLeaseS: 30,
  pickupRetryS: 2,
  convergeS: 10,
  lease: { driftMargin: 0.02, graceS: 2 },
  failure: { phiSuspect: 5, phiUnreachable: 9, windowSize: 100, minStdS: 0.1, probeFanout: 3, quorum: 2, tFailedS: 60 } satisfies FailureParams,
} as const;
