/**
 * TC-03: per-node CRDT replica (docs/P2P_DESIGN.md section 4, PRD REQ-STATE-001..003, section 10 `merge_task`).
 *
 * Task records merge as a join under a total order on (epoch, rank, owner, renew); drone status is LWW by `seq`;
 * shard leases are LWW by (epoch, renew); terminal tasks form a tombstone G-set that is pruned from gossip after
 * `P2P_DEFAULTS.tombstoneTtlS` local seconds but kept in the replica so late gossip cannot resurrect them.
 *
 * Determinism: no wall clock, no randomness; the caller passes `nowLocal`. Maps are only iterated
 * through sorted id lists. Agent-side module: imports nothing from the engine, the network model or safety.
 */
import { STATE_RANK, type Task, type TaskState } from '../sim/Task';
import {
  P2P_DEFAULTS,
  type DroneStatusRecord,
  type MergeOutcome,
  type NodeId,
  type ReplicaDelta,
  type ReplicaDigest,
  type ReplicaWant,
  type ShardLeaseRecord,
  type TaskKey,
  type TaskRecord,
} from './contracts';

// ---- merge order ------------------------------------------------------------------------------------------

/** Rank used in the merge key: `STATE_RANK`, except DELIVERED = 4.5 so that it beats ABORTED (tie rule, section 4)
 * while `rank >= 4` still means terminal and `rank >= 3` still means past the point of no return. */
export function keyRank(state: TaskState): number {
  return state === 'DELIVERED' ? 4.5 : STATE_RANK[state];
}

export function isTerminalState(state: TaskState): boolean {
  return state === 'DELIVERED' || state === 'ABORTED';
}

export function taskKey(rec: TaskRecord): TaskKey {
  return { epoch: rec.epoch, rank: keyRank(rec.state), owner: rec.owner, renew: rec.renew };
}

/** Owner component: lower id wins, null sorts after every id (so it loses). >0 when `a` wins. */
function cmpOwner(a: NodeId | null, b: NodeId | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? 1 : -1; // code-unit order, locale-independent
}

/** Total order on merge keys: >0 when `a` wins (is greater), <0 when `b` wins, 0 when equal. */
export function compareTaskKey(a: TaskKey, b: TaskKey): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  if (a.rank !== b.rank) return a.rank > b.rank ? 1 : -1;
  const o = cmpOwner(a.owner, b.owner);
  if (o !== 0) return o;
  if (a.renew !== b.renew) return a.renew > b.renew ? 1 : -1;
  return 0;
}

/** compareTaskKey on records without allocating keys. */
function cmpRecKey(a: TaskRecord, b: TaskRecord): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  const ra = keyRank(a.state);
  const rb = keyRank(b.state);
  if (ra !== rb) return ra > rb ? 1 : -1;
  const o = cmpOwner(a.owner, b.owner);
  if (o !== 0) return o;
  if (a.renew !== b.renew) return a.renew > b.renew ? 1 : -1;
  return 0;
}

/** Canonical tie-break on the remaining mutable fields when merge keys are equal (should not happen with honest
 * writers; keeps the join well-defined, i.e. commutative, on any input). >0 when `a` wins. */
function cmpRecContent(a: TaskRecord, b: TaskRecord): number {
  if (a.bid !== b.bid) {
    if (a.bid === null) return -1;
    if (b.bid === null) return 1;
    return a.bid > b.bid ? 1 : -1;
  }
  if (a.lease_s !== b.lease_s) return a.lease_s > b.lease_s ? 1 : -1;
  return 0;
}

/** Full record order used by `mergeTask` and the replica: merge key, then content tie-break. */
export function compareTaskRecord(a: TaskRecord, b: TaskRecord): number {
  return cmpRecKey(a, b) || cmpRecContent(a, b);
}

/** PRD section 10 `merge_task` + renewal counter: the max of the two records under the total order. Commutative,
 * associative and idempotent. Immutable payload (pickup, drop, dropId, ...) is assumed identical per task id. */
export function mergeTask(a: TaskRecord, b: TaskRecord): TaskRecord {
  return compareTaskRecord(a, b) >= 0 ? a : b;
}

/** Shard leases: LWW by (epoch, renew); then holder (lower id, null last), then lease_s. >0 when `a` wins. */
export function compareShardLease(a: ShardLeaseRecord, b: ShardLeaseRecord): number {
  if (a.epoch !== b.epoch) return a.epoch > b.epoch ? 1 : -1;
  if (a.renew !== b.renew) return a.renew > b.renew ? 1 : -1;
  const o = cmpOwner(a.holder, b.holder);
  if (o !== 0) return o;
  if (a.lease_s !== b.lease_s) return a.lease_s > b.lease_s ? 1 : -1;
  if (a.depot !== b.depot) return a.depot < b.depot ? 1 : -1;
  return 0;
}

/** Drone status: LWW by seq; equal seq falls back to t_local then canonical JSON (deterministic). >0 when `a` wins. */
export function compareStatus(a: DroneStatusRecord, b: DroneStatusRecord): number {
  if (a.seq !== b.seq) return a.seq > b.seq ? 1 : -1;
  if (a.t_local !== b.t_local) return a.t_local > b.t_local ? 1 : -1;
  const ja = JSON.stringify(normStatus(a));
  const jb = JSON.stringify(normStatus(b));
  return ja === jb ? 0 : ja > jb ? 1 : -1;
}

// ---- normalisation (unknown fields dropped, no aliasing between replicas) -----------------------------------

const TASK_STATES: readonly TaskState[] = ['UNASSIGNED', 'CLAIMED', 'COMMITTED', 'PICKED_UP', 'DELIVERED', 'ABORTED'];
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';
const isVec = (v: unknown): boolean => {
  const o = v as { x?: unknown; y?: unknown; z?: unknown } | null;
  return !!o && typeof o === 'object' && isNum(o.x) && isNum(o.y) && isNum(o.z);
};

/** Shape check for a record received over the network. */
export function isTaskRecord(x: unknown): x is TaskRecord {
  const r = x as Partial<TaskRecord> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    isStr(r.task_id) &&
    isStr(r.origin_depot) &&
    isVec(r.pickup) &&
    isVec(r.drop) &&
    (r.priority === 1 || r.priority === 2 || r.priority === 3) &&
    isNum(r.deadline) &&
    isNum(r.weight_kg) &&
    isStr(r.shard) &&
    TASK_STATES.includes(r.state as TaskState) &&
    isNum(r.epoch) &&
    (r.owner === null || isStr(r.owner)) &&
    (r.bid === null || isNum(r.bid)) &&
    isNum(r.renew) &&
    isNum(r.lease_s) &&
    isNum(r.created_at) &&
    isStr(r.dropId) &&
    isStr(r.type) &&
    typeof r.scripted === 'boolean' &&
    (r.reorderOf === undefined || isStr(r.reorderOf))
  );
}

export function isStatusRecord(x: unknown): x is DroneStatusRecord {
  const r = x as Partial<DroneStatusRecord> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    isStr(r.drone_id) &&
    isNum(r.seq) &&
    isVec(r.pos) &&
    isNum(r.soc) &&
    isStr(r.mode) &&
    Array.isArray(r.bundle) &&
    r.bundle.every(isStr) &&
    isNum(r.t_local) &&
    (r.suspects === undefined || (Array.isArray(r.suspects) && r.suspects.every(isStr))) &&
    (r.acks === undefined || isAcks(r.acks))
  );
}

function isAcks(x: unknown): boolean {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  for (const v of Object.values(x as Record<string, unknown>)) if (!isPair(v)) return false;
  return true;
}

export function isShardLeaseRecord(x: unknown): x is ShardLeaseRecord {
  const r = x as Partial<ShardLeaseRecord> | null;
  return (
    !!r &&
    typeof r === 'object' &&
    isStr(r.shard) &&
    isStr(r.depot) &&
    isNum(r.epoch) &&
    (r.holder === null || isStr(r.holder)) &&
    isNum(r.renew) &&
    isNum(r.lease_s)
  );
}

const v3 = (v: { x: number; y: number; z: number }) => ({ x: v.x, y: v.y, z: v.z });

/** Copy of the known fields only. */
export function normTask(r: TaskRecord): TaskRecord {
  const out: TaskRecord = {
    task_id: r.task_id,
    origin_depot: r.origin_depot,
    pickup: v3(r.pickup),
    drop: v3(r.drop),
    priority: r.priority,
    deadline: r.deadline,
    weight_kg: r.weight_kg,
    shard: r.shard,
    state: r.state,
    epoch: r.epoch,
    owner: r.owner,
    bid: r.bid,
    renew: r.renew,
    lease_s: r.lease_s,
    created_at: r.created_at,
    dropId: r.dropId,
    type: r.type,
    scripted: r.scripted,
  };
  if (r.reorderOf !== undefined) out.reorderOf = r.reorderOf;
  return out;
}

function normStatus(r: DroneStatusRecord): DroneStatusRecord {
  const out: DroneStatusRecord = { drone_id: r.drone_id, seq: r.seq, pos: v3(r.pos), soc: r.soc, mode: r.mode, bundle: [...r.bundle], t_local: r.t_local };
  if (r.acks !== undefined) {
    const acks: Record<string, [number, number]> = {};
    for (const id of Object.keys(r.acks).sort(cmpStr)) acks[id] = [r.acks[id][0], r.acks[id][1]];
    out.acks = acks;
  }
  if (r.suspects !== undefined) out.suspects = [...r.suspects];
  if (typeof r.endurance_s === 'number' && Number.isFinite(r.endurance_s)) out.endurance_s = r.endurance_s;
  return out;
}

function normShard(r: ShardLeaseRecord): ShardLeaseRecord {
  return { shard: r.shard, depot: r.depot, epoch: r.epoch, holder: r.holder, renew: r.renew, lease_s: r.lease_s };
}

/** Task record from a sim `Task` (depot intake). `lease_ttl` and timestamps stay behind: they are local-clock data. */
export function recordFromTask(t: Task, renew = 0, leaseS = 0): TaskRecord {
  const r: TaskRecord = {
    task_id: t.task_id,
    origin_depot: t.origin_depot,
    pickup: v3(t.pickup),
    drop: v3(t.drop),
    priority: t.priority,
    deadline: t.deadline,
    weight_kg: t.weight_kg,
    shard: t.shard,
    state: t.state,
    epoch: t.epoch,
    owner: t.owner,
    bid: t.bid,
    renew,
    lease_s: leaseS,
    created_at: t.created_at,
    dropId: t.dropId,
    type: t.type,
    scripted: t.scripted,
  };
  if (t.reorderOf !== undefined) r.reorderOf = t.reorderOf;
  return r;
}

// ---- replica ----------------------------------------------------------------------------------------------

export interface TaskMergeResult {
  task_id: string;
  outcome: MergeOutcome;
  /** The record held before the merge (undefined on insert). */
  prev?: TaskRecord;
}

export interface DeltaMergeResult {
  /** Task merges that changed the replica, in input order. */
  tasks: TaskMergeResult[];
  /** Drone ids whose status changed. */
  status: NodeId[];
  /** Shards whose lease changed. */
  shards: string[];
}

export type { ReplicaWant } from './contracts';

export interface DigestAnswer {
  /** Records the digest's sender lacks or holds older (send unicast). */
  delta: ReplicaDelta;
  /** Ids where the sender holds something newer than me or that I lack (ask for them). */
  want: ReplicaWant;
}

export interface ReplicaOptions {
  tombstoneTtlS?: number;
}

/**
 * Anti-entropy options (integration, message budget). `settleS`: a record whose merge key changed here less than
 * `settleS` local seconds ago is reported in digests with its previous key (omitted if it is new) and is not sent in
 * digest answers: the delta push already carries it, so a digest that crosses a push does not trigger a reply.
 * `status: false`: the digest carries no drone status (statuses refresh by push every second; LWW anti-entropy on
 * them only costs replies). Defaults (0, true) keep the TC-04 behaviour.
 */
export interface DigestOptions {
  settleS?: number;
  status?: boolean;
}

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted id list, cached and rebuilt only after an insert. */
class SortedKeys<V> {
  private sorted: string[] | null = [];
  constructor(readonly map: Map<string, V>) {}
  invalidate(): void {
    this.sorted = null;
  }
  ids(): readonly string[] {
    if (this.sorted === null) this.sorted = [...this.map.keys()].sort(cmpStr);
    return this.sorted;
  }
}

/** One node's replicated state. All mutation goes through `merge*` (remote) or `write*` (local). */
export class Replica {
  readonly tombstoneTtlS: number;
  /** Bumped on every change (merge or local write). Cheap staleness check for views. */
  version = 0;

  private readonly taskMap = new Map<string, TaskRecord>();
  private readonly statusMap = new Map<NodeId, DroneStatusRecord>();
  private readonly shardMap = new Map<string, ShardLeaseRecord>();
  private readonly taskIds = new SortedKeys(this.taskMap);
  private readonly statusIds = new SortedKeys(this.statusMap);
  private readonly shardIds = new SortedKeys(this.shardMap);
  /** Local time at which the current (epoch, owner, renew) of a task was first seen. Not gossiped. */
  private readonly seen = new Map<string, number>();
  /** Tombstone G-set: terminal task id -> local time it became terminal here. */
  private readonly tombs = new Map<string, number>();
  /** Local time at which the current status seq / shard lease was first seen. Not gossiped. */
  private readonly statusSeen = new Map<NodeId, number>();
  private readonly shardSeen = new Map<string, number>();
  /** Local time the task / shard merge key last changed here, and the key it replaced (null after an insert). */
  private readonly taskChanged = new Map<string, number>();
  private readonly taskPrev = new Map<string, TaskKey | null>();
  private readonly shardChanged = new Map<string, number>();
  private readonly shardPrev = new Map<string, [number, number] | null>();
  // dirty sets (insertion order; sorted when drained)
  private readonly dirtyTasks = new Set<string>();
  private readonly dirtyStatus = new Set<NodeId>();
  private readonly dirtyShards = new Set<string>();

  constructor(readonly nodeId: NodeId, opts: ReplicaOptions = {}) {
    this.tombstoneTtlS = opts.tombstoneTtlS ?? P2P_DEFAULTS.tombstoneTtlS;
  }

  // ---- tasks ----------------------------------------------------------------------------------------------

  /** Merge one remote task record. Returns what happened; changed records become dirty (epidemic relay). */
  mergeTask(incoming: TaskRecord, nowLocal: number): MergeOutcome {
    return this.applyTask(incoming, nowLocal, false).outcome;
  }

  /**
   * Local write: accepted only when `rec` is strictly greater than the current record in merge order (or the id is
   * new). Returns false (and changes nothing) otherwise.
   */
  writeTask(rec: TaskRecord, nowLocal: number): boolean {
    return this.applyTask(rec, nowLocal, true).outcome !== 'unchanged';
  }

  private applyTask(incoming: TaskRecord, nowLocal: number, strict: boolean): TaskMergeResult {
    const id = incoming.task_id;
    const cur = this.taskMap.get(id);
    if (cur !== undefined) {
      const c = strict ? cmpRecKey(incoming, cur) : compareTaskRecord(incoming, cur);
      if (c <= 0) return { task_id: id, outcome: 'unchanged', prev: cur };
    }
    const rec = normTask(incoming);
    this.taskMap.set(id, rec);
    this.taskChanged.set(id, nowLocal);
    this.taskPrev.set(id, cur === undefined ? null : taskKey(cur));
    if (cur === undefined) this.taskIds.invalidate();
    if (cur === undefined || cur.epoch !== rec.epoch || cur.renew !== rec.renew || cur.owner !== rec.owner) {
      this.seen.set(id, nowLocal);
    }
    if (isTerminalState(rec.state) && !this.tombs.has(id)) this.tombs.set(id, nowLocal);
    this.dirtyTasks.add(id);
    this.version++;
    return cur === undefined ? { task_id: id, outcome: 'inserted' } : { task_id: id, outcome: 'updated', prev: cur };
  }

  getTask(id: string): TaskRecord | undefined {
    return this.taskMap.get(id);
  }

  hasTask(id: string): boolean {
    return this.taskMap.has(id);
  }

  /** Sorted by task id. */
  taskIdList(): readonly string[] {
    return this.taskIds.ids();
  }

  /** All task records, sorted by task id. */
  tasks(): TaskRecord[] {
    return this.taskIds.ids().map((id) => this.taskMap.get(id)!);
  }

  get taskCount(): number {
    return this.taskMap.size;
  }

  /** Local time at which the current (epoch, owner, renew) of the task was first seen here. */
  seenAt(id: string): number | undefined {
    return this.seen.get(id);
  }

  /** Local time the task became terminal here (tombstone), if it did. */
  terminalAt(id: string): number | undefined {
    return this.tombs.get(id);
  }

  /** Terminal for longer than the tombstone TTL: kept, but no longer gossiped. */
  isPruned(id: string, nowLocal: number): boolean {
    const t = this.tombs.get(id);
    return t !== undefined && nowLocal - t > this.tombstoneTtlS;
  }

  /**
   * Rebuild a sim `Task` for the controller. `lease_ttl` is expressed on this replica's local clock
   * (`seenAt + lease_s`) for leased pre-pickup states, null otherwise. Timestamps that are not gossiped stay unset.
   */
  toTask(id: string): Task | undefined {
    const r = this.taskMap.get(id);
    return r === undefined ? undefined : taskFromRecord(r, this.seen.get(id));
  }

  // ---- drone status ---------------------------------------------------------------------------------------

  mergeStatus(incoming: DroneStatusRecord, nowLocal: number): boolean {
    return this.applyStatus(incoming, nowLocal, false);
  }

  /** Local write: seq must be strictly greater than the current one. */
  writeStatus(rec: DroneStatusRecord, nowLocal: number): boolean {
    return this.applyStatus(rec, nowLocal, true);
  }

  private applyStatus(incoming: DroneStatusRecord, nowLocal: number, strict: boolean): boolean {
    const id = incoming.drone_id;
    const cur = this.statusMap.get(id);
    if (cur !== undefined) {
      const c = strict ? incoming.seq - cur.seq : compareStatus(incoming, cur);
      if (c <= 0) return false;
    }
    this.statusMap.set(id, normStatus(incoming));
    if (cur === undefined) this.statusIds.invalidate();
    if (cur === undefined || cur.seq !== incoming.seq) this.statusSeen.set(id, nowLocal);
    this.dirtyStatus.add(id);
    this.version++;
    return true;
  }

  getStatus(id: NodeId): DroneStatusRecord | undefined {
    return this.statusMap.get(id);
  }

  /** Local time a newer seq of this drone's status was first seen here (feeds `reachable()`, TC-07). */
  statusSeenAt(id: NodeId): number | undefined {
    return this.statusSeen.get(id);
  }

  /** Sorted by drone id. */
  statusIdList(): readonly NodeId[] {
    return this.statusIds.ids();
  }

  statuses(): DroneStatusRecord[] {
    return this.statusIds.ids().map((id) => this.statusMap.get(id)!);
  }

  // ---- shard leases ---------------------------------------------------------------------------------------

  mergeShard(incoming: ShardLeaseRecord, nowLocal: number): boolean {
    return this.applyShard(incoming, nowLocal, false);
  }

  /** Local write: (epoch, renew) must be strictly greater than the current lease's. */
  writeShard(rec: ShardLeaseRecord, nowLocal: number): boolean {
    return this.applyShard(rec, nowLocal, true);
  }

  private applyShard(incoming: ShardLeaseRecord, nowLocal: number, strict: boolean): boolean {
    const id = incoming.shard;
    const cur = this.shardMap.get(id);
    if (cur !== undefined) {
      const c = strict
        ? incoming.epoch !== cur.epoch
          ? incoming.epoch - cur.epoch
          : incoming.renew - cur.renew
        : compareShardLease(incoming, cur);
      if (c <= 0) return false;
    }
    this.shardMap.set(id, normShard(incoming));
    this.shardChanged.set(id, nowLocal);
    this.shardPrev.set(id, cur === undefined ? null : [cur.epoch, cur.renew]);
    if (cur === undefined) this.shardIds.invalidate();
    if (cur === undefined || cur.epoch !== incoming.epoch || cur.renew !== incoming.renew || cur.holder !== incoming.holder) {
      this.shardSeen.set(id, nowLocal);
    }
    this.dirtyShards.add(id);
    this.version++;
    return true;
  }

  getShard(shard: string): ShardLeaseRecord | undefined {
    return this.shardMap.get(shard);
  }

  /** Local time the current (epoch, renew, holder) of the lease was first seen here. */
  shardSeenAt(shard: string): number | undefined {
    return this.shardSeen.get(shard);
  }

  shardIdList(): readonly string[] {
    return this.shardIds.ids();
  }

  shards(): ShardLeaseRecord[] {
    return this.shardIds.ids().map((id) => this.shardMap.get(id)!);
  }

  // ---- deltas -----------------------------------------------------------------------------------------------

  /** Merge a whole delta (records failing the shape check are skipped). Returns what changed. */
  mergeDelta(delta: Partial<ReplicaDelta>, nowLocal: number): DeltaMergeResult {
    const res: DeltaMergeResult = { tasks: [], status: [], shards: [] };
    if (Array.isArray(delta.tasks)) {
      for (const r of delta.tasks) {
        if (!isTaskRecord(r)) continue;
        const m = this.applyTask(r, nowLocal, false);
        if (m.outcome !== 'unchanged') res.tasks.push(m);
      }
    }
    if (Array.isArray(delta.status)) {
      for (const r of delta.status) if (isStatusRecord(r) && this.applyStatus(r, nowLocal, false)) res.status.push(r.drone_id);
    }
    if (Array.isArray(delta.shards)) {
      for (const r of delta.shards) if (isShardLeaseRecord(r) && this.applyShard(r, nowLocal, false)) res.shards.push(r.shard);
    }
    return res;
  }

  hasDirty(): boolean {
    return this.dirtyTasks.size > 0 || this.dirtyStatus.size > 0 || this.dirtyShards.size > 0;
  }

  /** Records changed since the last call (sorted by id; pruned tombstones left out), then clears the dirty sets. */
  takeDelta(nowLocal: number): ReplicaDelta {
    const tasks = [...this.dirtyTasks]
      .sort(cmpStr)
      .filter((id) => !this.isPruned(id, nowLocal))
      .map((id) => this.taskMap.get(id)!);
    const status = [...this.dirtyStatus].sort(cmpStr).map((id) => this.statusMap.get(id)!);
    const shards = [...this.dirtyShards].sort(cmpStr).map((id) => this.shardMap.get(id)!);
    this.dirtyTasks.clear();
    this.dirtyStatus.clear();
    this.dirtyShards.clear();
    return { tasks, status, shards };
  }

  /** Records for the given ids (unknown ids skipped; pruned tombstones included: the asker named them). */
  recordsFor(want: Partial<ReplicaWant>): ReplicaDelta {
    const pick = <V>(ids: unknown, m: Map<string, V>): V[] => {
      if (!Array.isArray(ids)) return [];
      const out: V[] = [];
      for (const id of [...new Set(ids.filter(isStr))].sort(cmpStr)) {
        const v = m.get(id);
        if (v !== undefined) out.push(v);
      }
      return out;
    };
    return { tasks: pick(want.tasks, this.taskMap), status: pick(want.status, this.statusMap), shards: pick(want.shards, this.shardMap) };
  }

  // ---- anti-entropy -----------------------------------------------------------------------------------------

  /** Digest of the non-pruned task keys, status seqs and shard (epoch, renew). See `DigestOptions`. */
  digest(nowLocal: number, opts: DigestOptions = {}): ReplicaDigest {
    const settle = opts.settleS ?? 0;
    const tasks: Record<string, TaskKey> = {};
    for (const id of this.taskIds.ids()) {
      if (this.isPruned(id, nowLocal)) continue;
      if (settle > 0 && nowLocal - (this.taskChanged.get(id) ?? -Infinity) < settle) {
        const prev = this.taskPrev.get(id);
        if (prev) tasks[id] = prev;
        continue;
      }
      tasks[id] = taskKey(this.taskMap.get(id)!);
    }
    const shards: Record<string, [number, number]> = {};
    for (const id of this.shardIds.ids()) {
      if (settle > 0 && nowLocal - (this.shardChanged.get(id) ?? -Infinity) < settle) {
        const prev = this.shardPrev.get(id);
        if (prev) shards[id] = prev;
        continue;
      }
      const s = this.shardMap.get(id)!;
      shards[id] = [s.epoch, s.renew];
    }
    if (opts.status === false) return { tasks, shards };
    const status: Record<NodeId, number> = {};
    for (const id of this.statusIds.ids()) status[id] = this.statusMap.get(id)!.seq;
    return { tasks, status, shards };
  }

  /**
   * Compare a peer's digest with this replica: the records the peer lacks (non-pruned) or holds older, and the ids
   * where the peer is newer or I lack the record. Pruned tombstones are still sent when the peer names the id with
   * an older key, so a peer stuck on a stale record learns the terminal state.
   */
  answerDigest(digest: Partial<ReplicaDigest>, nowLocal: number, opts: DigestOptions = {}): DigestAnswer {
    const delta: ReplicaDelta = { tasks: [], status: [], shards: [] };
    const want: ReplicaWant = { tasks: [], status: [], shards: [] };
    const settle = opts.settleS ?? 0;
    const recent = (m: Map<string, number>, id: string) => settle > 0 && nowLocal - (m.get(id) ?? -Infinity) < settle;
    const dt = isObj(digest.tasks) ? digest.tasks : {};
    // a digest without status asks for no status anti-entropy
    const withStatus = digest.status !== undefined;
    const ds = withStatus && isObj(digest.status) ? digest.status : {};
    const dsh = isObj(digest.shards) ? digest.shards : {};

    for (const id of this.taskIds.ids()) {
      if (recent(this.taskChanged, id)) continue; // in flight in my next push
      const mine = this.taskMap.get(id)!;
      const theirs = Object.prototype.hasOwnProperty.call(dt, id) ? dt[id] : undefined;
      if (theirs === undefined || !isKey(theirs)) {
        if (!this.isPruned(id, nowLocal)) delta.tasks.push(mine);
      } else if (compareTaskKey(taskKey(mine), theirs) > 0) delta.tasks.push(mine);
    }
    for (const id of Object.keys(dt).sort(cmpStr)) {
      const theirs = dt[id];
      if (!isKey(theirs)) continue;
      const mine = this.taskMap.get(id);
      if (mine === undefined || compareTaskKey(theirs, taskKey(mine)) > 0) want.tasks.push(id);
    }

    for (const id of withStatus ? this.statusIds.ids() : []) {
      const mine = this.statusMap.get(id)!;
      const seq = Object.prototype.hasOwnProperty.call(ds, id) ? ds[id] : undefined;
      if (!isNum(seq) || mine.seq > seq) delta.status.push(mine);
    }
    for (const id of Object.keys(ds).sort(cmpStr)) {
      const seq = ds[id];
      if (!isNum(seq)) continue;
      const mine = this.statusMap.get(id);
      if (mine === undefined || seq > mine.seq) want.status.push(id);
    }

    for (const id of this.shardIds.ids()) {
      if (recent(this.shardChanged, id)) continue;
      const mine = this.shardMap.get(id)!;
      const t = Object.prototype.hasOwnProperty.call(dsh, id) ? dsh[id] : undefined;
      if (!isPair(t) || cmpPair([mine.epoch, mine.renew], t) > 0) delta.shards.push(mine);
    }
    for (const id of Object.keys(dsh).sort(cmpStr)) {
      const t = dsh[id];
      if (!isPair(t)) continue;
      const mine = this.shardMap.get(id);
      if (mine === undefined || cmpPair(t, [mine.epoch, mine.renew]) > 0) want.shards.push(id);
    }
    return { delta, want };
  }

  /** Canonical, comparable view of the replicated (gossiped) state: no local metadata. */
  snapshot(): ReplicaDelta {
    return { tasks: this.tasks(), status: this.statuses(), shards: this.shards() };
  }
}

/** Build a controller `Task` from a record; `seenAt` is the local time the current lease was first seen. */
export function taskFromRecord(r: TaskRecord, seenAt: number | undefined): Task {
  const leased = (r.state === 'CLAIMED' || r.state === 'COMMITTED') && r.owner !== null;
  const t: Task = {
    task_id: r.task_id,
    origin_depot: r.origin_depot,
    pickup: v3(r.pickup),
    drop: v3(r.drop),
    priority: r.priority,
    deadline: r.deadline,
    weight_kg: r.weight_kg,
    shard: r.shard,
    state: r.state,
    epoch: r.epoch,
    owner: r.owner,
    bid: r.bid,
    lease_ttl: leased && seenAt !== undefined ? seenAt + r.lease_s : null,
    created_at: r.created_at,
    dropId: r.dropId,
    type: r.type,
    scripted: r.scripted,
  };
  if (r.reorderOf !== undefined) t.reorderOf = r.reorderOf;
  return t;
}

export function isEmptyDelta(d: ReplicaDelta): boolean {
  return d.tasks.length === 0 && d.status.length === 0 && d.shards.length === 0;
}

export function isEmptyWant(w: ReplicaWant): boolean {
  return w.tasks.length === 0 && w.status.length === 0 && w.shards.length === 0;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function isKey(x: unknown): x is TaskKey {
  const k = x as Partial<TaskKey> | null;
  return !!k && typeof k === 'object' && isNum(k.epoch) && isNum(k.rank) && (k.owner === null || isStr(k.owner)) && isNum(k.renew);
}

function isPair(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1]);
}

function cmpPair(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}
