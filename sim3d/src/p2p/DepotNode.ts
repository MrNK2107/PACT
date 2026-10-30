/**
 * TC-08 depot node (docs/P2P_DESIGN.md sections 6 and 7): one per depot, with its own replica, gossip engine, failure
 * detector and local clock. It is the single writer of every epoch-bumping write that is not a claim, for the tasks
 * it originates:
 *
 * - intake: the engine hands new (generated, scripted, burst) tasks to their origin depot, which writes the record
 *   and pushes it (urgently for priority 1);
 * - pickup arbitration: `PICKUP_REQ` -> `depotPickup` (merge the carried record, grant only the owner of the current
 *   epoch) with a per-task grant memory kept outside the merge and a fence record if anything ever out-ranks a grant;
 *   answered by unicast `PICKUP_GRANT` / `TASK_TAKEN`;
 * - lease expiry: the only re-opener of its tasks, after the observer bound `lease (1 + margin) + grace` on its own
 *   clock since it first saw the current (epoch, renew);
 * - lease acks: its status record carries `acks { task: [epoch, renew] }`, the renewals it has seen; owners count only
 *   those as confirmed (so the owner stops before this depot can re-open, I3);
 * - shard-lease authority for its catchment shards (`SHARD_LEASE` requests, STRICT policy);
 * - DECLARED_FAILED of a drone carrying one of its parcels: ABORTED + one replacement task (also when the carrier
 *   itself wrote ABORTED to give a parcel back). Replacements are ordered exactly once per task.
 *
 * Deterministic: local clock only, sorted iteration. No imports from the engine, the network model or safety.
 */
import type { Task } from '../sim/Task';
import type {
  Clock,
  DroneStatusRecord,
  Envelope,
  NetworkPort,
  NodeId,
  PickupAnswerPayload,
  PickupReqPayload,
  ProbeAckPayload,
  ProbePayload,
  ShardLeasePayload,
  ShardLeaseRecord,
  TaskRecord,
} from './contracts';
import type { Vec3 as Vec3Like } from '../world/types';
import { FailureDetector } from './failure';
import { GossipEngine } from './gossip';
import {
  abortRecord,
  depotAcceptHandBack,
  depotPickup,
  depotShardLeaseDecision,
  isPrePickup,
  observerLeaseExpired,
  reopenRecord,
  replacementRecord,
} from './ownership';
import { isShardLeaseRecord, isTaskRecord, recordFromTask, Replica, type DeltaMergeResult } from './replica';
import { byId, expectsToHear, type NodeEventSink, type P2PConfig, type WriteHook } from './node';

export interface DepotNodeOptions {
  id: NodeId;
  clock: Clock;
  port: NetworkPort;
  cfg: P2PConfig;
  /** Mast position (published in the depot status). */
  pos: Vec3Like;
  /** Shards this depot is the authority of. */
  catchmentShards: readonly string[];
  /** Ids of the other depots (their statuses are not drones). */
  depotIds: readonly NodeId[];
  events?: NodeEventSink;
  onWrite?: WriteHook;
}

export class DepotNode {
  readonly id: NodeId;
  readonly replica: Replica;
  readonly gossip: GossipEngine;
  readonly fd: FailureDetector;
  private readonly clock: Clock;
  private readonly port: NetworkPort;
  private readonly cfg: P2PConfig;
  private readonly pos: Vec3Like;
  private readonly catchment: ReadonlySet<string>;
  private readonly depotIds: ReadonlySet<NodeId>;
  private readonly emit: NodeEventSink;
  private readonly onWrite: WriteHook;
  /** Grant memory (outside the merge): task -> the owner and epoch the parcel was handed to. */
  private readonly grants = new Map<string, { owner: NodeId; epoch: number }>();
  /** Replacements ordered per aborted task (exactly once). */
  private readonly replaced = new Map<string, string>();
  /** Depot-local time of the last grant / renewal per shard. */
  private readonly shardGrantAt = new Map<string, number>();
  /** Own tasks not yet terminal (checked each tick for expiry, fences and failed carriers). */
  private readonly live = new Set<string>();
  /** Drones this depot has declared failed, with the reason. */
  private readonly failed = new Map<NodeId, string>();
  /** Last known location of each drone (beacon or gossiped status) and the local time it was learned. */
  private readonly located = new Map<NodeId, { pos: Vec3Like; at: number }>();
  private statusSeq = 0;
  private lastStatus = -Infinity;
  /** Counters for tests / reports. */
  readonly counters = { grants: 0, refusals: 0, reopens: 0, replacements: 0, fences: 0 };

  constructor(o: DepotNodeOptions) {
    this.id = o.id;
    this.clock = o.clock;
    this.port = o.port;
    this.cfg = o.cfg;
    this.pos = { x: o.pos.x, y: o.pos.y, z: o.pos.z };
    this.catchment = new Set(o.catchmentShards);
    this.depotIds = new Set(o.depotIds);
    this.emit = o.events ?? (() => {});
    this.onWrite = o.onWrite ?? (() => {});
    this.replica = new Replica(o.id);
    this.gossip = new GossipEngine(o.id, this.replica, o.clock, (env) => this.port.send(env), { ...o.cfg.gossip, onMerged: (res) => this.onMerged(res) });
    this.fd = new FailureDetector(o.id, o.cfg.failure.params, o.cfg.failure.opts);
  }

  get now(): number {
    return this.clock.nowLocal();
  }

  /** Task intake: write the new record (epoch 0, UNASSIGNED) and push it; priority 1 goes out at once. */
  intake(task: Task): TaskRecord | null {
    const rec = recordFromTask(task, 0, 0);
    if (rec.origin_depot !== this.id) return null;
    if (!this.write(rec)) return null;
    if (rec.priority === 1) this.gossip.urgent();
    return this.replica.getTask(rec.task_id)!;
  }

  grantOf(taskId: string): { owner: NodeId; epoch: number } | undefined {
    return this.grants.get(taskId);
  }

  replacementOf(taskId: string): string | undefined {
    return this.replaced.get(taskId);
  }

  // ---- inputs ---------------------------------------------------------------------------------------------

  onBeacon(src: NodeId, pos?: Vec3Like): void {
    if (src === this.id || this.depotIds.has(src)) return;
    this.fd.heartbeat(src, this.now);
    if (pos) this.locate(src, pos, this.now);
  }

  /** Did this depot expect to hear `drone` now (its possible positions within the expected range of the mast)? */
  expects(drone: NodeId, now = this.now): boolean {
    const x = this.cfg.expect;
    if (!x) return true;
    const l = this.located.get(drone);
    return !!l && expectsToHear(x, this.pos, l.pos, now - l.at);
  }

  onEnvelope(env: Envelope): void {
    if (!env || env.src === this.id || (env.dst !== '*' && env.dst !== this.id)) return;
    const p = env.payload as Record<string, unknown> | null;
    switch (env.type) {
      case 'GOSSIP_DELTA':
      case 'GOSSIP_DIGEST':
        this.gossip.onMessage(env);
        return;
      case 'PICKUP_REQ':
        if (p) this.onPickupReq(env.src, p as unknown as PickupReqPayload);
        return;
      case 'SHARD_LEASE':
        if (p) this.onShardLease(env.src, env.t_send, p as ShardLeasePayload);
        return;
      case 'PROBE': {
        const target = (p as Partial<ProbePayload> | null)?.target;
        if (typeof target !== 'string') return;
        const a = this.fd.answerProbe(target, this.now);
        const ack: ProbeAckPayload = { target, alive: a.alive, sinceS: a.sinceS };
        this.port.send({ type: 'PROBE_ACK', src: this.id, dst: env.src, t_send: this.now, payload: ack });
        return;
      }
      case 'DISTRESS':
        if (!this.depotIds.has(env.src)) this.fd.onDistress(env.src, this.now);
        return;
      default:
        return;
    }
  }

  // ---- tick -----------------------------------------------------------------------------------------------

  step(): void {
    const now = this.now;
    this.stepFailures(now);
    for (const id of [...this.live].sort(byId)) {
      const rec = this.replica.getTask(id);
      if (!rec) continue;
      if (rec.state === 'DELIVERED' || rec.state === 'ABORTED') {
        if (rec.state === 'ABORTED') this.orderReplacement(rec, 'aborted by its carrier');
        this.live.delete(id);
        continue;
      }
      const g = this.grants.get(id);
      if (g && (rec.state === 'UNASSIGNED' || isPrePickup(rec))) {
        // belt and braces: something out-ranked a parcel I handed out; re-state the grant at the higher epoch
        const fence: TaskRecord = { ...rec, state: 'PICKED_UP', owner: g.owner };
        if (this.write(fence)) {
          this.counters.fences++;
          this.gossip.urgent();
          this.emit({ type: 'grant_fenced', agent: this.id, data: { task: id, epoch: fence.epoch, owner: g.owner, node: this.id } });
        }
        continue;
      }
      if (rec.state === 'PICKED_UP' && rec.owner !== null && this.carrierLost(rec.owner, now)) {
        this.abortAndReplace(rec, `${rec.owner} declared failed (${this.failed.get(rec.owner)})`, { peer: rec.owner, declared: this.failed.get(rec.owner)! });
        continue;
      }
      if (rec.reorderOf !== undefined && (rec.state === 'UNASSIGNED' || isPrePickup(rec)) && this.originalDelivered(rec)) {
        // the carrier was not lost after all (out of contact, not dead): the parcel arrived, cancel the replacement
        const a = abortRecord(rec);
        this.replaced.set(id, ''); // cancelled: never replaced itself
        if (a && this.write(a)) {
          this.gossip.urgent();
          this.emit({ type: 'replacement_cancelled', agent: null, data: { task: id, of: rec.reorderOf, node: this.id }, kind: 'task', text: `${id} cancelled by ${this.id}: ${rec.reorderOf} was delivered after all` });
        }
        continue;
      }
      if (!g && isPrePickup(rec)) {
        const seen = this.replica.seenAt(id);
        if (seen !== undefined && observerLeaseExpired(seen, now, this.cfg.lease, rec.lease_s)) {
          const r = reopenRecord(rec);
          if (r && this.write(r)) {
            this.counters.reopens++;
            this.gossip.urgent();
            this.emit({ type: 'lease_expired', agent: null, data: { task: id, epoch: r.epoch, owner: rec.owner, node: this.id }, kind: 'warn', text: `${id} lease expired at ${this.id} - re-opened at epoch ${r.epoch}` });
            this.emit({ type: 'board_lease_expired', agent: rec.owner, data: { task: id, epoch: r.epoch, node: this.id } });
          }
        }
      }
    }
    if (now - this.lastStatus >= this.cfg.statusPeriodS) this.publishStatus(now);
    this.gossip.step();
  }

  // ---- internals --------------------------------------------------------------------------------------------

  private write(rec: TaskRecord): boolean {
    if (!this.replica.writeTask(rec, this.now)) return false;
    const w = this.replica.getTask(rec.task_id)!;
    if (w.origin_depot === this.id && w.state !== 'DELIVERED' && w.state !== 'ABORTED') this.live.add(w.task_id);
    this.onWrite(w, this.id);
    return true;
  }

  private onMerged(res: DeltaMergeResult): void {
    const now = this.now;
    for (const m of res.tasks) {
      const rec = this.replica.getTask(m.task_id)!;
      if (rec.origin_depot === this.id) this.live.add(m.task_id);
    }
    for (const id of res.status) {
      if (this.depotIds.has(id) || id === this.id) continue;
      this.fd.heardIndirect(id, now);
      const st = this.replica.getStatus(id);
      if (st) {
        this.locate(id, st.pos, now);
        if (st.endurance_s !== undefined) this.fd.setEndurance(id, st.endurance_s, now);
      }
      for (const target of st?.suspects ?? []) {
        if (target === this.id || this.depotIds.has(target)) continue;
        const t = this.replica.statusSeenAt(target);
        if (t === undefined || now - t > this.cfg.reachWindowS) this.fd.reportUnreachable(id, target, now);
      }
    }
  }

  private onPickupReq(from: NodeId, req: PickupReqPayload): void {
    if (!isTaskRecord(req.task) || typeof req.epoch !== 'number') return;
    const now = this.now;
    const id = req.task.task_id;
    if (req.task.origin_depot === this.id) {
      const out = this.replica.mergeTask(req.task, now);
      if (out !== 'unchanged') this.live.add(id);
    }
    const d = depotPickup({ depot: this.id, depotRecord: this.replica.getTask(id), carried: req.task, requester: from, epoch: req.epoch, granted: this.grants.get(id) ?? null });
    if (d.record && d.record.origin_depot === this.id) {
      if (this.write(d.record)) this.gossip.urgent();
    }
    const answer: PickupAnswerPayload = { task_id: id, epoch: req.epoch, record: this.replica.getTask(id) ?? null };
    if (d.kind === 'PICKUP_GRANT') {
      if (!d.regrant) {
        this.grants.set(id, { owner: from, epoch: d.record.epoch });
        this.counters.grants++;
      }
      this.emit({ type: 'board_pickup_grant', agent: from, data: { task: id, epoch: d.record.epoch, node: this.id, regrant: d.regrant } });
    } else {
      answer.reason = d.reason;
      this.counters.refusals++;
      this.emit({ type: 'board_task_taken', agent: from, data: { task: id, reason: d.reason, detail: d.detail, epoch: req.epoch, node: this.id } });
    }
    this.port.send({ type: d.kind, src: this.id, dst: from, t_send: now, payload: answer });
  }

  private onShardLease(from: NodeId, tReq: number, p: ShardLeasePayload): void {
    const now = this.now;
    for (const h of Array.isArray(p.handBack) ? p.handBack : []) {
      if (!isShardLeaseRecord(h) || !this.catchment.has(h.shard)) continue;
      const acc = depotAcceptHandBack(this.replica.getShard(h.shard) ?? null, h, from);
      if (acc && this.replica.writeShard(acc, now)) {
        this.shardGrantAt.delete(h.shard);
        this.emit({ type: 'shard_lease_released', agent: from, data: { shard: h.shard, node: this.id } });
      }
    }
    const leases: ShardLeaseRecord[] = [];
    const shards = Array.isArray(p.shards) ? [...new Set(p.shards.filter((s): s is string => typeof s === 'string'))].sort(byId) : [];
    for (const s of shards) {
      if (!this.catchment.has(s)) continue;
      const cur = this.replica.getShard(s) ?? null;
      const dec = depotShardLeaseDecision(cur, this.shardGrantAt.get(s) ?? null, { shard: s, depot: this.id, requester: from }, now, this.cfg.shardLease);
      if (dec.kind !== 'refused' && this.replica.writeShard(dec.lease, now)) {
        this.shardGrantAt.set(s, now);
        if (dec.kind === 'granted') this.emit({ type: 'shard_lease_granted', agent: from, data: { shard: s, epoch: dec.lease.epoch, node: this.id } });
      }
      const l = this.replica.getShard(s);
      if (l) leases.push(l);
    }
    if (!shards.length) return;
    const answer: ShardLeasePayload = { leases, t_req: tReq };
    this.port.send({ type: 'SHARD_LEASE', src: this.id, dst: from, t_send: now, payload: answer });
  }

  private locate(id: NodeId, pos: Vec3Like, at: number): void {
    const l = this.located.get(id);
    if (l && l.at > at) return;
    this.located.set(id, { pos: { x: pos.x, y: pos.y, z: pos.z }, at });
  }

  /**
   * Failure detector: the depot is an observer too (its own UNREACHABLE vote when it expected to hear the drone and
   * neither beacons nor a fresh gossiped status arrive); declared drones lose the parcels they carry (abort +
   * replacement, once).
   */
  private stepFailures(now: number): void {
    for (const id of this.fd.knownPeers()) {
      if (this.fd.health(id, now) !== 'UNREACHABLE') continue;
      const t = this.replica.statusSeenAt(id);
      if (t !== undefined && now - t <= this.cfg.reachWindowS) continue;
      if (this.expects(id, now)) this.fd.reportUnreachable(this.id, id, now);
    }
    for (const tr of this.fd.update(now)) {
      if (tr.to === 'DECLARED_FAILED') {
        this.failed.set(tr.peer, tr.reason ?? 'quorum');
        const carrying = [...this.live].sort(byId).filter((id) => {
          const r = this.replica.getTask(id);
          return !!r && r.state === 'PICKED_UP' && r.owner === tr.peer;
        });
        const data: Record<string, unknown> = { peer: tr.peer, reason: tr.reason, node: this.id, carrying };
        if (tr.reason === 'quorum') data.observers = this.fd.declaredBy(tr.peer);
        const l = this.located.get(tr.peer);
        if (l) data.lastLocatedS = Math.round((now - l.at) * 1000) / 1000;
        this.emit({ type: 'peer_failed', agent: this.id, data });
      } else if (tr.from === 'DECLARED_FAILED') {
        this.failed.delete(tr.peer);
        this.emit({ type: 'peer_alive', agent: this.id, data: { peer: tr.peer, from: tr.from, node: this.id } });
      }
    }
  }

  /** Some task this replacement stands in for (its `reorderOf` chain) has been delivered. */
  private originalDelivered(rec: TaskRecord): boolean {
    let of = rec.reorderOf;
    for (let k = 0; of !== undefined && k < 16; k++) {
      const o = this.replica.getTask(of);
      if (!o) return false;
      if (o.state === 'DELIVERED') return true;
      of = o.reorderOf;
    }
    return false;
  }

  /**
   * The carrier is lost once this depot declared it failed (REQ-FAIL-004). The declaration itself carries the physical
   * evidence (DISTRESS; a quorum of observers that expected to hear it; or silence past its endurance bound), so the
   * depot acts on it at once (AT-06: recovery is measured from the declaration).
   */
  private carrierLost(owner: NodeId, _now: number): boolean {
    return this.failed.has(owner);
  }

  private abortAndReplace(rec: TaskRecord, reason: string, cause: { peer: NodeId; declared: string }): void {
    const a = abortRecord(rec);
    if (!a || !this.write(a)) return;
    this.gossip.urgent();
    this.emit({ type: 'board_aborted', agent: rec.owner, data: { task: rec.task_id, reason, node: this.id } });
    this.orderReplacement(a, reason, cause);
  }

  /** One replacement per aborted task (assumption O4), written by the origin depot only. */
  private orderReplacement(aborted: TaskRecord, reason: string, cause: { peer: NodeId; declared: string } | null = null): void {
    if (aborted.origin_depot !== this.id || this.replaced.has(aborted.task_id)) return;
    // a parcel lost with a failed carrier is re-ordered as urgent (priority 1: pushed at once, re-auctioned at once,
    // REQ-AUC-003); a parcel its carrier gives back keeps its priority
    const re = replacementRecord(aborted, 1, this.now, cause !== null);
    this.replaced.set(aborted.task_id, re.task_id);
    if (!this.write(re)) return;
    this.counters.replacements++;
    this.gossip.urgent();
    const data: Record<string, unknown> = { of: aborted.task_id, task: re.task_id, reason, node: this.id, cause: cause ? 'declared_failed' : 'carrier_abort' };
    if (cause) {
      data.peer = cause.peer;
      data.declared = cause.declared;
    }
    this.emit({ type: 'task_reordered', agent: aborted.owner, data, kind: 'task', text: `${aborted.task_id} re-ordered as ${re.task_id} by ${this.id} (${reason})` });
    this.emit({ type: 'board_reordered', agent: null, data: { task: re.task_id, of: aborted.task_id, node: this.id } });
  }

  private publishStatus(now: number): void {
    this.lastStatus = now;
    const acks: Record<string, [number, number]> = {};
    for (const id of [...this.live].sort(byId)) {
      const r = this.replica.getTask(id);
      if (r && isPrePickup(r)) acks[id] = [r.epoch, r.renew];
    }
    const st: DroneStatusRecord = { drone_id: this.id, seq: ++this.statusSeq, pos: this.pos, soc: 100, mode: 'CONNECTED', bundle: [], t_local: Math.round(now * 1000) / 1000, acks };
    this.replica.writeStatus(st, now);
  }
}
