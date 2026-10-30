/**
 * Shared configuration and plumbing of the P2P nodes (drone `P2PNode`, `DepotNode`). Agent side: imports nothing from
 * the engine, the network model or safety; the engine hands each node a `NetworkPort`, a `Clock`
 * and two callbacks (an event sink and a write hook that feeds the omniscient ledger).
 */
import {
  P2P_DEFAULTS,
  type FailureParams,
  type LeaseParams,
  type NodeId,
  type PartitionPolicyName,
  type ShardLeaseParams,
  type TaskRecord,
} from './contracts';
import type { Vec3 } from '../world/types';
import type { FailureDetectorOptions } from './failure';
import type { GossipOptions } from './gossip';
import { DEFAULT_LEASE_PARAMS, DEFAULT_SHARD_LEASE_PARAMS } from './ownership';

/** A structured event a node reports (the engine stamps sim time and logs it). */
export interface NodeEvent {
  type: string;
  agent: NodeId | null;
  data: Record<string, unknown>;
  /** Human-readable line for the UI log (optional). */
  text?: string;
  kind?: 'info' | 'task' | 'warn' | 'fault';
}

export type NodeEventSink = (e: NodeEvent) => void;

/**
 * A-priori radio knowledge of a node (equipment range and the map's static radio zones; never the live link state):
 * whether an observer should expect to hear a peer. Failure-quorum votes come only from observers that expected to
 * (docs/P2P_DESIGN.md section 7): a peer that merely left an observer's range is not evidence of a failure.
 */
export interface LinkExpectation {
  /**
   * Range (m) the link between point `a` and any point within `bRadius` of `b` is expected to have at least
   * (nominal range x the worst static map zone factor touching either end).
   */
  rangeM(a: Vec3, b: Vec3, bRadius: number): number;
  /** Upper bound of a drone's ground speed (m/s): how far a peer can have moved since it was last located. */
  maxSpeedMps: number;
  /** An observer expects to hear a peer whose possible positions all lie within this fraction of the range. */
  margin: number;
}

/** Does an observer at `obs` expect to hear a peer last located at `last`, `ageS` local seconds ago? */
export function expectsToHear(x: LinkExpectation, obs: Vec3, last: Vec3, ageS: number): boolean {
  const d = Math.hypot(obs.x - last.x, obs.y - last.y, obs.z - last.z);
  const r = x.maxSpeedMps * Math.max(0, ageS);
  return d + r <= x.margin * x.rangeM(obs, last, r);
}

/** Called after every successful local task write (claim, renew, grant, re-open, ...): feeds the ledger. */
export type WriteHook = (rec: TaskRecord, by: NodeId) => void;

export interface P2PConfig {
  lease: LeaseParams;
  policy: PartitionPolicyName;
  /** Gossip engine options shared by every node (base period from the scenario's `gossip_period_s`). */
  gossip: Omit<GossipOptions, 'onMerged' | 'phaseS'>;
  /** Drone / depot status publication period (local s). Statuses carry reachability (drones) and lease acks (depots). */
  statusPeriodS: number;
  /** `REACH_WINDOW_S`: a node is reachable while a newer status of it arrived within this window (local s). */
  reachWindowS: number;
  failure: { params: FailureParams; opts: Partial<FailureDetectorOptions> };
  shardLease: ShardLeaseParams;
  /** PICKUP_REQ resend period (local s). */
  pickupRetryS: number;
  /**
   * Radio expectation for failure-quorum votes (engine: nominal range + static map zones). Absent: every observer
   * that misses a peer votes (TC-09 unit behaviour).
   */
  expect?: LinkExpectation;
}

/**
 * Integration defaults (docs/P2P_DESIGN.md; the choices are logged in DECISIONS.md):
 * - gossip: min period 1 s (= the base period: the 0.25 s floor allowed 240 pushes/min, AT-11 budget is 120),
 *   anti-entropy settle window 1.5 s, no status in digests (statuses are re-published every second anyway), two
 *   named answerers per digest (new / returning peers first) and digest acceleration only when this node is behind;
 * - failure detector: acceptable pause 0.5 s (TC-09 measured 136 false SUSPECT / peer-hour at 40 % loss with the
 *   pure phi 5 / 9, about 2 with 0.5 s), probes at most every 5 s per target.
 */
export function defaultP2PConfig(over: { leaseTtlS?: number; tCommitS?: number; policy?: PartitionPolicyName; gossipPeriodS?: number } = {}): P2PConfig {
  const base = over.gossipPeriodS ?? 1;
  return {
    lease: { ...DEFAULT_LEASE_PARAMS, leaseTtlS: over.leaseTtlS ?? DEFAULT_LEASE_PARAMS.leaseTtlS, tCommitS: over.tCommitS ?? DEFAULT_LEASE_PARAMS.tCommitS },
    policy: over.policy ?? 'QUORUM',
    gossip: { basePeriodS: base, minPeriodS: base, digestEvery: P2P_DEFAULTS.digestEvery, maxFactor: P2P_DEFAULTS.gossipMaxFactor, settleS: 1.5, digestStatus: false, askPeers: 2, accelerateOnAnswer: false },
    statusPeriodS: 1,
    reachWindowS: P2P_DEFAULTS.reachWindowS,
    failure: { params: { ...P2P_DEFAULTS.failure }, opts: { acceptablePauseS: 0.5, probeIntervalS: 5 } },
    shardLease: { ...DEFAULT_SHARD_LEASE_PARAMS },
    pickupRetryS: P2P_DEFAULTS.pickupRetryS,
  };
}

/** Static map knowledge a node is given (PRD: depots and their catchments are a-priori knowledge). */
export interface DepotInfo {
  id: NodeId;
  /** Shards whose authority this depot is (`world.shards` catchment). */
  catchmentShards: readonly string[];
}

export const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
