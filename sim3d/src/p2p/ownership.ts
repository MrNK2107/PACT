/**
 * TC-07 ownership, decentralised (docs/P2P_DESIGN.md section 6; 03 section 3.5; PRD REQ-OWN-001..006).
 *
 * Pure functions and small classes over `TaskRecord`, `ShardLeaseRecord`, `FleetView` and local-clock numbers.
 * This is the replicated counterpart of `src/sim/TaskBoard.ts`: same rules (claim, commit, renew, expiry / re-open,
 * depot pickup arbitration, release, abort + replacement), but every write is a new record that is strictly greater
 * in the task merge order, so it wins any merge against the record it replaces (I2: epochs never go down).
 *
 * Time: every time argument is a node's *local* clock (`Clock.nowLocal()`), never simulation time. Lease safety (I3)
 * rests on an asymmetry: the owner stops after `lease` on its own clock measured from its last *confirmed* renewal,
 * any observer re-opens only after `lease * (1 + driftMargin) + grace` on its clock measured from when it first saw
 * that renewal.
 *
 * No imports from the engine, the network model, rendering or safety.
 */
import { STATE_RANK, urgentReplacementTerms, type TaskState } from '../sim/Task';
import {
  P2P_DEFAULTS,
  type FleetView,
  type LeaseParams,
  type NodeId,
  type PartitionPolicy,
  type PartitionPolicyName,
  type ShardLeaseParams,
  type ShardLeaseRecord,
  type TaskRecord,
} from './contracts';
import { compareTaskRecord, mergeTask } from './replica';

export type { ShardLeaseParams } from './contracts';

/** PRD section 15 defaults: lease 20 s (renew every 5), T_commit 3 s, drift margin 0.02 + grace 2 s. */
export const DEFAULT_LEASE_PARAMS: LeaseParams = {
  leaseTtlS: 20,
  tCommitS: 3,
  driftMargin: P2P_DEFAULTS.lease.driftMargin,
  graceS: P2P_DEFAULTS.lease.graceS,
};

// ---- merge order (the one in replica.ts) ------------------------------------------------------------------------

/**
 * Task merge order (P2P_DESIGN section 4): epoch, state rank (DELIVERED > ABORTED on tie), owner (lower id wins,
 * null after every id), renew, then the canonical content tie-break. > 0 when `a` wins, < 0 when `b` wins.
 * Alias of replica.ts `compareTaskRecord` (one merge order for the whole layer).
 */
export const compareTaskRecords: (a: TaskRecord, b: TaskRecord) => number = compareTaskRecord;

/** Join of two records of the same task (replica.ts `mergeTask`; `a` on equal records). */
export const mergeTaskRecords: (a: TaskRecord, b: TaskRecord) => TaskRecord = mergeTask;

export function isPrePickup(r: TaskRecord): boolean {
  return r.state === 'CLAIMED' || r.state === 'COMMITTED';
}

export function isTerminalRecord(r: TaskRecord): boolean {
  return r.state === 'DELIVERED' || r.state === 'ABORTED';
}

// ---- lease timing -------------------------------------------------------------------------------------------

/** Observer bound: `lease * (1 + driftMargin) + grace` local seconds. */
export function observerBoundS(leaseS: number, driftMargin: number, graceS: number): number {
  return leaseS * (1 + driftMargin) + graceS;
}

/**
 * Owner side (zombie-stop, I3): the owner's lease has lapsed when more than `lease` local seconds passed since
 * `lastAckLocal`, the owner-local time at which it *wrote* its last renewal that came back confirmed (the claim
 * itself before any confirmation). Measured from the write, not from the ack's arrival: that is the conservative end.
 */
export function ownerLeaseLapsed(lastAckLocal: number, nowLocal: number, p: LeaseParams, leaseS = p.leaseTtlS): boolean {
  return nowLocal - lastAckLocal > leaseS;
}

/**
 * Observer side: a pre-pickup lease is expired in this replica's view when more than
 * `lease * (1 + driftMargin) + grace` local seconds passed since `seenAtLocal`, the local time this replica first saw
 * the record's current `(epoch, renew)`.
 */
export function observerLeaseExpired(seenAtLocal: number, nowLocal: number, p: LeaseParams, leaseS = p.leaseTtlS): boolean {
  return nowLocal - seenAtLocal > observerBoundS(leaseS, p.driftMargin, p.graceS);
}

// ---- record transitions -------------------------------------------------------------------------------------
// Each returns the new record, or null when the write is not legal from `rec`. A non-null result is strictly greater
// than `rec` in the merge order.

/** UNASSIGNED -> CLAIMED(owner = me, epoch + 1, bid, renew 0, lease_s). Run after the radio auction is won. */
export function claimRecord(rec: TaskRecord, me: NodeId, bid: number, leaseS: number = DEFAULT_LEASE_PARAMS.leaseTtlS): TaskRecord | null {
  if (rec.state !== 'UNASSIGNED') return null;
  return { ...rec, state: 'CLAIMED', epoch: rec.epoch + 1, owner: me, bid, renew: 0, lease_s: leaseS };
}

/** CLAIMED -> COMMITTED once `tCommitS` passed on the owner's clock since its claim, if it still owns the record. */
export function commitRecord(rec: TaskRecord, me: NodeId, claimedAtLocal: number, nowLocal: number, p: LeaseParams): TaskRecord | null {
  if (rec.state !== 'CLAIMED' || rec.owner !== me) return null;
  if (nowLocal - claimedAtLocal < p.tCommitS) return null;
  return { ...rec, state: 'COMMITTED' };
}

/** Owner renewal: renew + 1, pre-pickup only (post-pickup leases are sticky, REQ-OWN-002). */
export function renewRecord(rec: TaskRecord, me: NodeId): TaskRecord | null {
  if (!isPrePickup(rec) || rec.owner !== me) return null;
  return { ...rec, renew: rec.renew + 1 };
}

/** Re-open a pre-pickup record: UNASSIGNED, epoch + 1, owner null, bid null, renew 0. Concurrent re-opens are equal. */
export function reopenRecord(rec: TaskRecord): TaskRecord | null {
  if (!isPrePickup(rec)) return null;
  return { ...rec, state: 'UNASSIGNED', epoch: rec.epoch + 1, owner: null, bid: null, renew: 0 };
}

/**
 * Observer re-open: a node other than the owner may re-open a pre-pickup record whose lease expired in its view
 * (`observerLeaseExpired` from `seenAtLocal`). The lease length is the record's own `lease_s`.
 */
export function observerReopen(rec: TaskRecord, by: NodeId, seenAtLocal: number, nowLocal: number, p: LeaseParams): TaskRecord | null {
  if (!isPrePickup(rec) || rec.owner === by) return null;
  if (!observerLeaseExpired(seenAtLocal, nowLocal, p, rec.lease_s)) return null;
  return reopenRecord(rec);
}

/** Owner gives a pre-pickup task back (re-open with a higher epoch). A picked-up parcel goes through `abortRecord`. */
export function releaseRecord(rec: TaskRecord, me: NodeId): TaskRecord | null {
  if (rec.owner !== me) return null;
  return reopenRecord(rec);
}

/** PICKED_UP -> DELIVERED, written by the owner at the drop. */
export function deliveredRecord(rec: TaskRecord, me: NodeId): TaskRecord | null {
  if (rec.state !== 'PICKED_UP' || rec.owner !== me) return null;
  return { ...rec, state: 'DELIVERED' };
}

/**
 * Any non-terminal state -> ABORTED, same epoch (rank 4 beats every live state). Written by the origin depot after
 * `DECLARED_FAILED` of the carrier (or an unreachable destination); pair it with `replacementRecord`.
 */
export function abortRecord(rec: TaskRecord): TaskRecord | null {
  if (isTerminalRecord(rec)) return null;
  return { ...rec, state: 'ABORTED' };
}

/**
 * Replacement parcel for an aborted task (assumption O4): id `<id>:r<n>`, UNASSIGNED, epoch + 1, no owner, fresh
 * creation time, `reorderOf` = the aborted id. `n` is the origin depot's per-task replacement counter (1-based).
 * `urgent` (the carrier was declared failed, AT-06): priority 1 and a fresh delivery window of the original length
 * (at least 60 s) from `createdAt`, so the re-order is pushed and re-auctioned at once instead of queueing behind
 * fresher orders with its original, already spent, deadline. Otherwise priority and deadline are kept.
 */
export function replacementRecord(aborted: TaskRecord, n: number, createdAt: number, urgent = false): TaskRecord {
  // a parcel lost with a failed carrier: a new order with a fresh delivery window (the original one, at least 60 s)
  const extra: Partial<TaskRecord> = urgent ? urgentReplacementTerms(aborted, createdAt) : {};
  return {
    ...aborted,
    ...extra,
    task_id: `${aborted.task_id}:r${n}`,
    state: 'UNASSIGNED',
    epoch: aborted.epoch + 1,
    owner: null,
    bid: null,
    renew: 0,
    created_at: createdAt,
    reorderOf: aborted.task_id,
  };
}

// ---- depot pickup arbitration (PRD section 10 depot_pickup) ----------------------------------------------------

export interface PickupRequest {
  /** The arbitrating depot's id; when set, a task of another origin depot is refused. */
  depot?: NodeId;
  /** The depot's own replica record for the task (undefined when it has none). */
  depotRecord: TaskRecord | undefined;
  /** The record the drone carries in its PICKUP_REQ (merged first; ignored when its task id differs). */
  carried?: TaskRecord;
  requester: NodeId;
  /** The epoch the requester claims to own. */
  epoch: number;
  /**
   * The depot's own memory of the parcel it handed out for this task, if any (kept outside the merge: one depot
   * grants each task once, even if a stale re-open later out-ranks its PICKED_UP record in some replica).
   */
  granted?: { owner: NodeId; epoch: number } | null;
}

export type PickupRefusal = 'unknown_task' | 'wrong_depot' | 'terminal' | 'already_picked_up' | 'stale_epoch' | 'not_owner' | 'not_claimed';

export type PickupDecision =
  /** Hand the parcel over. `record` (PICKED_UP) is the depot's new replica record; `regrant` = a repeated answer. */
  | { kind: 'PICKUP_GRANT'; record: TaskRecord; regrant: boolean }
  /** Refuse. `record` is the depot's new replica record (the merge, possibly a fence that re-asserts its grant). */
  | { kind: 'TASK_TAKEN'; reason: PickupRefusal; detail: string; record: TaskRecord | null };

/**
 * PRD section 10 `depot_pickup` over a replica: merge the carried record, then grant only the owner of the current
 * epoch of a CLAIMED/COMMITTED record. Idempotent for resends (same requester and epoch after a lost grant). When
 * the depot already handed the parcel out but its replica record was out-ranked by a stale re-open / claim, the
 * returned record is a *fence*: the grant re-stated (PICKED_UP, grantee) at the higher epoch, which beats it.
 * Every returned record is >= the depot's record in the merge order (I2).
 */
export function depotPickup(req: PickupRequest): PickupDecision {
  const { depotRecord, requester, epoch } = req;
  const carried = req.carried && (!depotRecord || req.carried.task_id === depotRecord.task_id) ? req.carried : undefined;
  const merged = depotRecord && carried ? mergeTaskRecords(depotRecord, carried) : (depotRecord ?? carried);
  if (!merged) return { kind: 'TASK_TAKEN', reason: 'unknown_task', detail: 'no record', record: null };
  if (req.depot !== undefined && merged.origin_depot !== req.depot) {
    return { kind: 'TASK_TAKEN', reason: 'wrong_depot', detail: `origin ${merged.origin_depot}`, record: depotRecord ?? null };
  }
  if (isTerminalRecord(merged)) return { kind: 'TASK_TAKEN', reason: 'terminal', detail: `state ${merged.state}`, record: merged };

  if (req.granted) {
    const g = req.granted;
    const fence: TaskRecord = STATE_RANK[merged.state] >= STATE_RANK.PICKED_UP ? merged : { ...merged, state: 'PICKED_UP', owner: g.owner };
    if (g.owner === requester && g.epoch === epoch) return { kind: 'PICKUP_GRANT', record: fence, regrant: true };
    return { kind: 'TASK_TAKEN', reason: 'already_picked_up', detail: `granted to ${g.owner} at epoch ${g.epoch}`, record: fence };
  }
  if (merged.state === 'PICKED_UP') {
    if (merged.owner === requester && merged.epoch === epoch) return { kind: 'PICKUP_GRANT', record: merged, regrant: true };
    return { kind: 'TASK_TAKEN', reason: 'already_picked_up', detail: `held by ${merged.owner}`, record: merged };
  }
  if (merged.state === 'UNASSIGNED') return { kind: 'TASK_TAKEN', reason: 'not_claimed', detail: `epoch ${merged.epoch} open`, record: merged };
  if (epoch < merged.epoch) return { kind: 'TASK_TAKEN', reason: 'stale_epoch', detail: `epoch ${epoch} < ${merged.epoch}`, record: merged };
  if (merged.owner !== requester) return { kind: 'TASK_TAKEN', reason: 'not_owner', detail: `owner ${merged.owner}`, record: merged };
  if (epoch !== merged.epoch) return { kind: 'TASK_TAKEN', reason: 'stale_epoch', detail: `epoch ${epoch} unknown (depot ${merged.epoch})`, record: merged };
  return { kind: 'PICKUP_GRANT', record: { ...merged, state: 'PICKED_UP' }, regrant: false };
}

// ---- owner-side lease bookkeeping -----------------------------------------------------------------------------

interface HeldLease {
  epoch: number;
  leaseS: number;
  claimedAt: number;
  /** Local write time per renew number of this epoch. */
  writes: Map<number, number>;
  lastWrite: number;
  confirmedRenew: number;
  lastAck: number;
  committed: boolean;
  sticky: boolean;
}

/**
 * Per held task, on the owner's local clock: when it claimed, when it wrote each renewal, the last renewal confirmed
 * back (gossip carrying `renew >=` its own, at its epoch), renew cadence `lease / 4`, commit due after `tCommitS`, and
 * the zombie-stop check (I3). After pickup the lease is sticky and never lapses.
 */
export class OwnerLeaseTracker {
  private leases = new Map<string, HeldLease>();
  constructor(readonly p: LeaseParams = DEFAULT_LEASE_PARAMS) {}

  /** Start tracking right after writing a claim (`rec` = the CLAIMED record). The claim is the initial ack base. */
  track(rec: TaskRecord, nowLocal: number): void {
    this.leases.set(rec.task_id, {
      epoch: rec.epoch,
      leaseS: rec.lease_s,
      claimedAt: nowLocal,
      writes: new Map([[rec.renew, nowLocal]]),
      lastWrite: nowLocal,
      confirmedRenew: -1,
      lastAck: nowLocal,
      committed: rec.state === 'COMMITTED',
      sticky: false,
    });
  }

  /** Record that the owner wrote renewal `renew` (from `renewRecord`) at `nowLocal`. */
  renewed(taskId: string, renew: number, nowLocal: number): void {
    const l = this.leases.get(taskId);
    if (!l) return;
    l.writes.set(renew, nowLocal);
    l.lastWrite = nowLocal;
  }

  /**
   * A peer or depot echoed this task at `(epoch, renew)`: every renewal up to `renew` of the held epoch is confirmed.
   * The ack base becomes the write time of the newest confirmed renewal the owner actually wrote.
   */
  confirm(taskId: string, epoch: number, renew: number): void {
    const l = this.leases.get(taskId);
    if (!l || epoch !== l.epoch || renew <= l.confirmedRenew) return;
    let best = -1;
    for (const r of l.writes.keys()) if (r <= renew && r > best) best = r;
    if (best < 0 || best <= l.confirmedRenew) return;
    l.confirmedRenew = best;
    l.lastAck = Math.max(l.lastAck, l.writes.get(best)!);
  }

  markCommitted(taskId: string): void {
    const l = this.leases.get(taskId);
    if (l) l.committed = true;
  }

  /** Point of no return: the depot granted the pickup; the lease no longer lapses on silence. */
  markPickedUp(taskId: string): void {
    const l = this.leases.get(taskId);
    if (l) l.sticky = true;
  }

  renewDue(taskId: string, nowLocal: number): boolean {
    const l = this.leases.get(taskId);
    return !!l && !l.sticky && nowLocal - l.lastWrite >= l.leaseS / 4;
  }

  commitDue(taskId: string, nowLocal: number): boolean {
    const l = this.leases.get(taskId);
    return !!l && !l.committed && !l.sticky && nowLocal - l.claimedAt >= this.p.tCommitS;
  }

  lapsed(taskId: string, nowLocal: number): boolean {
    const l = this.leases.get(taskId);
    return !!l && !l.sticky && ownerLeaseLapsed(l.lastAck, nowLocal, this.p, l.leaseS);
  }

  /** Zombie-stop: ids (sorted) whose lease lapsed; they stop being tracked. The owner must not act on them again. */
  expire(nowLocal: number): string[] {
    const out: string[] = [];
    for (const id of this.leases.keys()) if (this.lapsed(id, nowLocal)) out.push(id);
    out.sort();
    for (const id of out) this.leases.delete(id);
    return out;
  }

  drop(taskId: string): void {
    this.leases.delete(taskId);
  }

  has(taskId: string): boolean {
    return this.leases.has(taskId);
  }

  held(): string[] {
    return [...this.leases.keys()].sort();
  }

  lastAck(taskId: string): number | undefined {
    return this.leases.get(taskId)?.lastAck;
  }

  confirmedRenew(taskId: string): number | undefined {
    return this.leases.get(taskId)?.confirmedRenew;
  }
}

// ---- partition policies (03 section 3.5f, PRD 9.2) --------------------------------------------------------------

/** QUORUM test: reachable known drones (me included) are a strict majority of the known fleet. */
export function quorumHolds(view: FleetView): boolean {
  const known = view.knownFleet();
  if (known.length === 0) return false;
  const knownSet = new Set(known);
  let n = 0;
  for (const id of view.reachable()) if (knownSet.has(id)) n++;
  return n * 2 > known.length;
}

/** STRICT test: the task's shard lease is live in my view and held by a reachable drone. */
export function shardHeldByReachable(shard: string, view: FleetView): boolean {
  const s = view.shardLease(shard);
  if (!s || !s.live || s.lease.holder === null) return false;
  return view.reachable().includes(s.lease.holder);
}

export interface PartitionPolicyOpts {
  /** OPTIMISTIC_BOUNDED: max claims held that were made without QUORUM (P2P_DEFAULTS.maxOptimistic). */
  maxOptimistic?: number;
}

class StrictPolicy implements PartitionPolicy {
  readonly name = 'STRICT' as const;
  mayClaimNew(task: TaskRecord, view: FleetView): boolean {
    return shardHeldByReachable(task.shard, view);
  }
}

class QuorumPolicy implements PartitionPolicy {
  readonly name = 'QUORUM' as const;
  mayClaimNew(_task: TaskRecord, view: FleetView): boolean {
    return quorumHolds(view);
  }
}

class OptimisticBoundedPolicy implements PartitionPolicy {
  readonly name = 'OPTIMISTIC_BOUNDED' as const;
  constructor(readonly maxOptimistic: number) {}
  mayClaimNew(task: TaskRecord, view: FleetView): boolean {
    if (quorumHolds(view)) return true;
    return task.priority >= 2 && view.optimisticClaims() < this.maxOptimistic;
  }
}

export function createPartitionPolicy(name: PartitionPolicyName, opts: PartitionPolicyOpts = {}): PartitionPolicy {
  switch (name) {
    case 'STRICT':
      return new StrictPolicy();
    case 'QUORUM':
      return new QuorumPolicy();
    case 'OPTIMISTIC_BOUNDED':
      return new OptimisticBoundedPolicy(opts.maxOptimistic ?? P2P_DEFAULTS.maxOptimistic);
  }
}

/**
 * Policy decision plus whether the claim counts as optimistic (made while QUORUM did not hold), which the caller
 * feeds back into `FleetView.optimisticClaims()`. Only OPTIMISTIC_BOUNDED ever makes optimistic claims.
 */
export function claimDecision(policy: PartitionPolicy, task: TaskRecord, view: FleetView): { allowed: boolean; optimistic: boolean } {
  const allowed = policy.mayClaimNew(task, view);
  return { allowed, optimistic: allowed && policy.name === 'OPTIMISTIC_BOUNDED' && !quorumHolds(view) };
}

// ---- shard leases (REQ-OWN-005) ---------------------------------------------------------------------------------

export const DEFAULT_SHARD_LEASE_PARAMS: ShardLeaseParams = {
  leaseS: P2P_DEFAULTS.shardLeaseS,
  driftMargin: P2P_DEFAULTS.lease.driftMargin,
  graceS: P2P_DEFAULTS.lease.graceS,
};

/** Shard lease LWW order: (epoch, renew). > 0 when `a` wins. */
export function compareShardLeases(a: ShardLeaseRecord, b: ShardLeaseRecord): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  if (a.renew !== b.renew) return a.renew > b.renew ? 1 : -1;
  return 0;
}

/** Depot view: held (holder set) and not expired under the observer bound since the depot's last grant / renewal. */
export function depotShardLeaseLive(current: ShardLeaseRecord | null, lastGrantLocal: number | null, nowLocal: number, p: ShardLeaseParams = DEFAULT_SHARD_LEASE_PARAMS): boolean {
  if (!current || current.holder === null || lastGrantLocal === null) return false;
  return nowLocal - lastGrantLocal <= observerBoundS(current.lease_s, p.driftMargin, p.graceS);
}

export type ShardLeaseDecision =
  /** `granted`: a new lease (epoch + 1); `renewed`: the live holder's renewal (renew + 1). Set lastGrantLocal = nowLocal. */
  | { kind: 'granted' | 'renewed'; lease: ShardLeaseRecord }
  | { kind: 'refused'; lease: ShardLeaseRecord | null; reason: 'held_by_other' };

/**
 * Depot-side SHARD_LEASE decision: the live holder renewing -> renew + 1; free (no holder) or expired in the depot's
 * view -> grant epoch + 1 to the requester; otherwise refuse. `lastGrantLocal` is the depot-local time of its last
 * grant or renewal of `current`.
 */
export function depotShardLeaseDecision(
  current: ShardLeaseRecord | null,
  lastGrantLocal: number | null,
  req: { shard: string; depot: NodeId; requester: NodeId },
  nowLocal: number,
  p: ShardLeaseParams = DEFAULT_SHARD_LEASE_PARAMS,
): ShardLeaseDecision {
  const live = depotShardLeaseLive(current, lastGrantLocal, nowLocal, p);
  if (current && live) {
    if (current.holder === req.requester) return { kind: 'renewed', lease: { ...current, renew: current.renew + 1, lease_s: p.leaseS } };
    return { kind: 'refused', lease: current, reason: 'held_by_other' };
  }
  return { kind: 'granted', lease: { shard: req.shard, depot: req.depot, epoch: (current?.epoch ?? 0) + 1, holder: req.requester, renew: 0, lease_s: p.leaseS } };
}

/** Holder side: the lease lapsed when more than `lease_s` local seconds passed since sending the last acked request. */
export function holderShardLeaseLapsed(lastAckSentLocal: number, nowLocal: number, leaseS: number): boolean {
  return nowLocal - lastAckSentLocal > leaseS;
}

/** Delegation: the holder hands the lease back (`holder = null`, renew + 1). Null if `me` does not hold it. */
export function handBackShardLease(lease: ShardLeaseRecord, me: NodeId): ShardLeaseRecord | null {
  if (lease.holder !== me) return null;
  return { ...lease, holder: null, renew: lease.renew + 1 };
}

/** Depot accepts a hand-back from the current holder `from` if it is that holder's lease (same epoch, newer). */
export function depotAcceptHandBack(current: ShardLeaseRecord | null, handed: ShardLeaseRecord, from: NodeId): ShardLeaseRecord | null {
  if (!current || current.holder !== from || handed.holder !== null) return null;
  if (handed.shard !== current.shard || handed.epoch !== current.epoch || compareShardLeases(handed, current) <= 0) return null;
  return handed;
}

interface HeldShard {
  lease: ShardLeaseRecord;
  /** Holder-local send time of the latest request the depot acked for this epoch. */
  base: number;
}

/**
 * A drone's own shard leases on its local clock. It sends SHARD_LEASE requests (noting the local send time, echoed
 * back in the depot's answer) and holds a lease only while its last *acked* request is younger than `lease_s`. A side
 * partitioned from the depot thus loses the lease on its own clock before the depot's observer bound lets it re-grant.
 */
export class ShardLeaseHolder {
  private held = new Map<string, HeldShard>();
  private lastRequest = new Map<string, number>();
  constructor(readonly me: NodeId) {}

  /** Note a request sent at `nowLocal` (drives the renew cadence `lease_s / 3`). */
  requested(shard: string, nowLocal: number): void {
    this.lastRequest.set(shard, nowLocal);
  }

  /** The depot's answer to a request sent at `requestSentLocal`: the lease as the depot now has it. */
  onAnswer(lease: ShardLeaseRecord, requestSentLocal: number): void {
    const cur = this.held.get(lease.shard);
    if (lease.holder !== this.me) {
      if (cur && compareShardLeases(lease, cur.lease) > 0) this.held.delete(lease.shard);
      return;
    }
    if (!cur || lease.epoch > cur.lease.epoch) {
      this.held.set(lease.shard, { lease, base: requestSentLocal });
      return;
    }
    if (lease.epoch < cur.lease.epoch) return; // stale answer of an older epoch
    cur.base = Math.max(cur.base, requestSentLocal);
    if (compareShardLeases(lease, cur.lease) > 0) cur.lease = lease;
  }

  holds(shard: string, nowLocal: number): boolean {
    const h = this.held.get(shard);
    return !!h && !holderShardLeaseLapsed(h.base, nowLocal, h.lease.lease_s);
  }

  /** Renewal due: held, and `lease_s / 3` since the last request. */
  renewDue(shard: string, nowLocal: number): boolean {
    const h = this.held.get(shard);
    if (!h) return false;
    const last = this.lastRequest.get(shard) ?? -Infinity;
    return nowLocal - last >= h.lease.lease_s / 3;
  }

  lease(shard: string): ShardLeaseRecord | undefined {
    return this.held.get(shard)?.lease;
  }

  /** Shards held and not lapsed, sorted. Lapsed entries are forgotten (shard_lease_lost). */
  heldShards(nowLocal: number): string[] {
    const out: string[] = [];
    for (const [s, h] of this.held) {
      if (holderShardLeaseLapsed(h.base, nowLocal, h.lease.lease_s)) this.held.delete(s);
      else out.push(s);
    }
    return out.sort();
  }

  /** Delegation: stop holding and return the hand-back record to send to the depot. */
  handBack(shard: string): ShardLeaseRecord | null {
    const h = this.held.get(shard);
    if (!h) return null;
    this.held.delete(shard);
    return handBackShardLease(h.lease, this.me);
  }
}

// ---- post-merge duplicate resolution (03 section 3.5g, REQ-OWN-006) ------------------------------------------------

export type DuplicateStage = 'pre_pickup' | 'post_pickup';

/** Why a held task was lost in a merge. `duplicate` events are the ones logged as `duplicate_resolved`. */
export type LossReason = 'outbid' | 'superseded' | 'reopened' | 'taken' | 'aborted';

export interface DuplicateResolvedData {
  taskId: string;
  stage: DuplicateStage;
  node: NodeId;
  winner: NodeId | null;
  reason: LossReason;
  /** Another drone owns the merged record (a real duplicate), as opposed to a re-open / abort. */
  duplicate: boolean;
  heldEpoch: number;
  mergedEpoch: number;
  mergedState: TaskState;
}

export type DuplicateResolution =
  /**
   * Keep acting. `reassert` (post-pickup only): the merged record out-ranks my pickup with a stale pre-pickup state
   * (a re-open / claim from a replica that never saw the pickup); ownership is sticky after pickup, so this record
   * (my state at the merged epoch) should be written and gossiped. It is strictly greater than the merged record.
   */
  | { action: 'keep'; reassert: TaskRecord | null }
  /** Pre-pickup: drop the task (bundle repair) and rejoin the auction. */
  | { action: 'drop'; stage: 'pre_pickup'; event: DuplicateResolvedData }
  /** Post-pickup: I carry a parcel another drone won; divert to my origin depot (or safe-drop). */
  | { action: 'divert'; stage: 'post_pickup'; event: DuplicateResolvedData };

/**
 * After merging, compare what I hold (`held`, my last own view of the task) with the replica's merged record.
 * The merge loser acts: pre-pickup it drops, post-pickup it diverts; the winner keeps.
 */
export function resolveAfterMerge(held: TaskRecord, merged: TaskRecord, me: NodeId): DuplicateResolution {
  if (held.task_id !== merged.task_id) throw new Error(`resolveAfterMerge: ${held.task_id} vs ${merged.task_id}`);
  const ev = (stage: DuplicateStage, reason: LossReason): DuplicateResolvedData => ({
    taskId: held.task_id,
    stage,
    node: me,
    winner: merged.owner,
    reason,
    duplicate: merged.owner !== null && merged.owner !== me && merged.state !== 'ABORTED',
    heldEpoch: held.epoch,
    mergedEpoch: merged.epoch,
    mergedState: merged.state,
  });
  if (held.owner !== me) return { action: 'keep', reassert: null };

  if (held.state === 'PICKED_UP' || held.state === 'DELIVERED') {
    if (STATE_RANK[merged.state] < STATE_RANK.PICKED_UP) {
      // stale pre-pickup write out-ranked my pickup: ownership is sticky, re-state it at the merged epoch
      return { action: 'keep', reassert: { ...held, epoch: merged.epoch, renew: merged.renew } };
    }
    if (merged.owner === me && merged.state !== 'ABORTED') return { action: 'keep', reassert: null };
    if (held.state === 'DELIVERED') return { action: 'keep', reassert: null }; // nothing left to divert
    return { action: 'divert', stage: 'post_pickup', event: ev('post_pickup', merged.state === 'ABORTED' ? 'aborted' : 'taken') };
  }

  if (isPrePickup(held)) {
    if (merged.owner === me && merged.epoch >= held.epoch && merged.state !== 'UNASSIGNED' && merged.state !== 'ABORTED') {
      return { action: 'keep', reassert: null };
    }
    let reason: LossReason;
    if (merged.state === 'ABORTED') reason = 'aborted';
    else if (merged.state === 'UNASSIGNED') reason = 'reopened';
    else if (STATE_RANK[merged.state] >= STATE_RANK.PICKED_UP) reason = 'taken';
    else if (merged.epoch === held.epoch) reason = 'outbid';
    else reason = 'superseded';
    return { action: 'drop', stage: 'pre_pickup', event: ev('pre_pickup', reason) };
  }
  return { action: 'keep', reassert: null };
}
