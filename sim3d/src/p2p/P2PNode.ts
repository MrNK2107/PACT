/**
 * Drone-side P2P node (TC-07 / TC-09 integration, docs/P2P_DESIGN.md sections 5 to 7): one replica, its gossip
 * engine, the owner-side lease tracker, the shard-lease holder, the failure detector, the partition policy and a
 * `FleetView` over the replica. `ReplicaBoard` exposes it to the controller as a `TaskBoardView`.
 *
 * Writes this node may make (single-writer rule, design section 6): claim (only over a record it sees UNASSIGNED),
 * commit, renew, pre-pickup release, DELIVERED, and the owner's own ABORTED of a parcel it carries back (the origin
 * depot then orders the replacement). It never re-opens a lease, never writes PICKED_UP (the depot's grant does) and
 * never claims over CLAIMED / COMMITTED, even when the lease looks expired in its view.
 *
 * Deterministic: local clock only, no randomness, sorted iteration. Imports nothing from the engine, the network
 * model or safety.
 */
import type { Task } from '../sim/Task';
import type {
  Clock,
  DistressPayload,
  DroneMode,
  DroneStatusRecord,
  Envelope,
  FleetView,
  NetworkPort,
  NodeId,
  PartitionPolicy,
  PeerHealth,
  PickupAnswerPayload,
  PickupReqPayload,
  ProbeAckPayload,
  ProbePayload,
  ShardLeasePayload,
  ShardLeaseRecord,
  TaskRecord,
} from './contracts';
import { FailureDetector } from './failure';
import { GossipEngine } from './gossip';
import {
  claimDecision,
  claimRecord,
  createPartitionPolicy,
  isPrePickup,
  observerBoundS,
  OwnerLeaseTracker,
  quorumHolds,
  releaseRecord,
  renewRecord,
  resolveAfterMerge,
  ShardLeaseHolder,
} from './ownership';
import { isShardLeaseRecord, isTaskRecord, Replica, type DeltaMergeResult } from './replica';
import { byId, expectsToHear, type DepotInfo, type NodeEventSink, type P2PConfig, type WriteHook } from './node';
import type { Vec3 } from '../world/types';

export type PickupResult = 'PICKUP_GRANT' | 'TASK_TAKEN' | 'PENDING';

interface PendingPickup {
  epoch: number;
  firstAt: number;
  lastSent: number;
  result: 'PICKUP_GRANT' | 'TASK_TAKEN' | null;
}

export interface DroneBodyView {
  pos: { x: number; y: number; z: number };
  battery: number;
  /** Own upper bound of the seconds it can still stay aloft (published as `endurance_s`, 03 section 3.6). */
  enduranceS?: number;
  /** On a pad charging: a shard-lease holder hands its leases back (delegation, REQ-OWN-005). */
  charging?: boolean;
  /** Shard of the current position: a holder outside its home catchment hands its leases back. */
  shard?: string;
}

export interface P2PNodeOptions {
  id: NodeId;
  clock: Clock;
  port: NetworkPort;
  cfg: P2PConfig;
  depots: readonly DepotInfo[];
  /** Depot of this drone's home pad ('' for a public pad): its catchment shards are the ones it leases (STRICT). */
  homeDepot: NodeId;
  /**
   * Configured fleet roster: every drone id the scenario launches, known to every node at boot like any fleet
   * configuration. `knownFleet` (the QUORUM denominator) is this roster minus DECLARED_FAILED drones (Decision 19).
   * Absent (unit harnesses): every drone this node has ever seen.
   */
  roster?: () => readonly NodeId[];
  events?: NodeEventSink;
  onWrite?: WriteHook;
}


export class P2PNode {
  readonly id: NodeId;
  readonly replica: Replica;
  readonly gossip: GossipEngine;
  readonly tracker: OwnerLeaseTracker;
  readonly shards: ShardLeaseHolder;
  readonly fd: FailureDetector;
  readonly policy: PartitionPolicy;
  readonly view: FleetView;
  /** Bumps when a priority-1 task is first seen (event-driven re-auction, REQ-AUC-003). */
  urgentCount = 0;

  private readonly clock: Clock;
  private readonly port: NetworkPort;
  private readonly cfg: P2PConfig;
  private readonly depotIds: ReadonlySet<NodeId>;
  private readonly homeShards: readonly string[];
  private readonly homeDepot: NodeId;
  private readonly emit: NodeEventSink;
  private readonly onWrite: WriteHook;
  private readonly roster: (() => readonly NodeId[]) | null;
  /** My last own view of each task I hold (the `held` side of `resolveAfterMerge`). */
  private readonly own = new Map<string, TaskRecord>();
  private readonly optimistic = new Set<string>();
  private readonly pickups = new Map<string, PendingPickup>();
  /** Tasks whose pickup was already answered with a grant to the controller. */
  private readonly handedOut = new Set<string>();
  private readonly health = new Map<NodeId, PeerHealth>();
  private suspects: NodeId[] = [];
  private statusSeq = 0;
  private lastStatus = -Infinity;
  private lastShardReq = -Infinity;
  private heldShardSet: string[] = [];
  /** Local time of my last hand-back per shard: older answers (requests sent before it) must not re-hold it. */
  private readonly handedBackAt = new Map<string, number>();
  private body: DroneBodyView = { pos: { x: 0, y: 0, z: 0 }, battery: 100 };
  private reachCache: { at: number; ids: NodeId[] } | null = null;
  /** Last known location of each peer (beacon or gossiped status) and the local time it was learned. */
  private readonly located = new Map<NodeId, { pos: Vec3; at: number }>();

  constructor(o: P2PNodeOptions) {
    this.id = o.id;
    this.clock = o.clock;
    this.port = o.port;
    this.cfg = o.cfg;
    this.depotIds = new Set(o.depots.map((d) => d.id));
    this.homeDepot = o.homeDepot;
    this.homeShards = [...(o.depots.find((d) => d.id === o.homeDepot)?.catchmentShards ?? [])].sort(byId);
    this.emit = o.events ?? (() => {});
    this.onWrite = o.onWrite ?? (() => {});
    this.roster = o.roster ?? null;
    this.replica = new Replica(o.id);
    this.gossip = new GossipEngine(o.id, this.replica, o.clock, (env) => this.port.send(env), { ...o.cfg.gossip, onMerged: (res) => this.onMerged(res) });
    this.tracker = new OwnerLeaseTracker(o.cfg.lease);
    this.shards = new ShardLeaseHolder(o.id);
    this.fd = new FailureDetector(o.id, o.cfg.failure.params, o.cfg.failure.opts);
    this.policy = createPartitionPolicy(o.cfg.policy);
    this.view = this.makeView();
  }

  get now(): number {
    return this.clock.nowLocal();
  }

  isDepot(id: NodeId): boolean {
    return this.depotIds.has(id);
  }

  // ---- inputs ---------------------------------------------------------------------------------------------

  /** A beacon (HEARTBEAT) from `src` reached me: phi-accrual sample (and its position, when the beacon carries one). */
  onBeacon(src: NodeId, pos?: Vec3): void {
    if (src === this.id || this.isDepot(src)) return;
    this.fd.heartbeat(src, this.now);
    if (pos) this.locate(src, pos, this.now);
  }

  /**
   * Did I expect to hear `peer` now (design section 7)? Its possible positions since it was last located (a ball of
   * radius maxSpeed x age) lie within `margin` of the expected range from me. Without radio knowledge: always.
   */
  expects(peer: NodeId, now = this.now): boolean {
    const x = this.cfg.expect;
    if (!x) return true;
    const l = this.located.get(peer);
    return !!l && expectsToHear(x, this.body.pos, l.pos, now - l.at);
  }

  /** Peers I currently suspect (integrated health not ALIVE): they get no new work from me (design section 7). */
  suspected(peer: NodeId): boolean {
    return (this.health.get(peer) ?? 'ALIVE') !== 'ALIVE';
  }

  /** Any P2P envelope addressed to me (or broadcast). Unknown types are ignored (NFR-3). */
  onEnvelope(env: Envelope): void {
    if (!env || env.src === this.id || (env.dst !== '*' && env.dst !== this.id)) return;
    const p = env.payload as Record<string, unknown> | null;
    switch (env.type) {
      case 'GOSSIP_DELTA':
      case 'GOSSIP_DIGEST':
        this.gossip.onMessage(env);
        return;
      case 'PICKUP_GRANT':
      case 'TASK_TAKEN':
        if (p) this.onPickupAnswer(env.type, env.src, p as unknown as PickupAnswerPayload);
        return;
      case 'SHARD_LEASE':
        if (p) this.onShardAnswer(p as ShardLeasePayload);
        return;
      case 'PROBE': {
        const target = (p as Partial<ProbePayload> | null)?.target;
        if (typeof target !== 'string') return;
        const a = this.fd.answerProbe(target, this.now);
        const ack: ProbeAckPayload = { target, alive: a.alive, sinceS: a.sinceS };
        this.port.send({ type: 'PROBE_ACK', src: this.id, dst: env.src, t_send: this.now, payload: ack });
        return;
      }
      case 'PROBE_ACK': {
        const a = p as Partial<ProbeAckPayload> | null;
        if (a && typeof a.target === 'string' && typeof a.alive === 'boolean') this.fd.onProbeAck(env.src, a.target, a.alive, this.now);
        return;
      }
      case 'DISTRESS':
        if (!this.isDepot(env.src)) this.fd.onDistress(env.src, this.now);
        return;
      default:
        return;
    }
  }

  // ---- tick -----------------------------------------------------------------------------------------------

  /** Before the controller runs: lease confirmations and lapses, so `holds()` is current. */
  preStep(body: DroneBodyView): void {
    this.body = body;
    const now = this.now;
    this.reachCache = null;
    for (const id of this.tracker.held()) {
      const rec = this.replica.getTask(id);
      if (!rec) continue;
      const ack = this.replica.getStatus(rec.origin_depot)?.acks?.[id];
      if (ack) this.tracker.confirm(id, ack[0], ack[1]);
    }
    // zombie-stop (I3): a lapsed lease is forgotten; holds() turns false and the controller stops acting on it
    for (const id of this.tracker.expire(now)) {
      this.own.delete(id);
      this.optimistic.delete(id);
      this.pickups.delete(id);
      this.emit({ type: 'lease_lapsed', agent: this.id, data: { task: id, node: this.id } });
    }
  }

  /** After the controller ran: owner writes (commit, renew), pickup resends, shard leases, status, health, gossip. */
  step(): void {
    const now = this.now;
    for (const id of this.tracker.held()) {
      const rec = this.replica.getTask(id);
      if (!rec || rec.owner !== this.id || !isPrePickup(rec)) continue;
      if (this.tracker.commitDue(id, now) && rec.state === 'CLAIMED') {
        const c: TaskRecord = { ...rec, state: 'COMMITTED' };
        if (this.write(c)) {
          this.tracker.markCommitted(id);
          this.emit({ type: 'board_committed', agent: this.id, data: { task: id, epoch: c.epoch, node: this.id } });
        }
      } else if (this.tracker.renewDue(id, now)) {
        const r = renewRecord(rec, this.id);
        if (r && this.write(r)) this.tracker.renewed(id, r.renew, now);
      }
    }
    for (const id of [...this.pickups.keys()].sort(byId)) {
      const pp = this.pickups.get(id)!;
      if (pp.result === null && now - pp.lastSent >= this.cfg.pickupRetryS) this.sendPickupReq(id, pp, now);
    }
    if (this.cfg.policy === 'STRICT') this.stepShardLeases(now);
    this.stepHealth(now);
    if (now - this.lastStatus >= this.cfg.statusPeriodS) this.publishStatus(now);
    this.gossip.step();
  }

  /** Flush urgent pushes written during the controller update (claims) in the same tick. */
  flush(): void {
    this.gossip.step();
  }

  // ---- ownership API (ReplicaBoard) -------------------------------------------------------------------------

  /** UNASSIGNED records I may claim now: the partition policy allows it and the origin depot is in contact. */
  claimable(rec: TaskRecord): boolean {
    if (rec.state !== 'UNASSIGNED') return false;
    if (!this.depotInContact(rec.origin_depot)) return false;
    return claimDecision(this.policy, rec, this.view).allowed;
  }

  /** The origin depot's status reached me within the reach window: it can arbitrate and acknowledge my lease. */
  depotInContact(depot: NodeId): boolean {
    const t = this.replica.statusSeenAt(depot);
    return t !== undefined && this.now - t <= this.cfg.reachWindowS;
  }

  /** Claim after the radio auction: a local write over a record I see UNASSIGNED, gated by the policy. */
  claim(taskId: string, bid: number): boolean {
    const rec = this.replica.getTask(taskId);
    if (!rec || rec.state !== 'UNASSIGNED') return false;
    if (!this.depotInContact(rec.origin_depot)) return false;
    const d = claimDecision(this.policy, rec, this.view);
    if (!d.allowed) return false;
    const c = claimRecord(rec, this.id, bid, this.cfg.lease.leaseTtlS);
    if (!c || !this.write(c)) return false;
    const now = this.now;
    this.tracker.track(c, now);
    if (d.optimistic) this.optimistic.add(taskId);
    this.pickups.delete(taskId);
    this.gossip.urgent();
    this.emit({ type: 'board_claimed', agent: this.id, data: { task: taskId, epoch: c.epoch, bid, node: this.id, optimistic: d.optimistic } });
    return true;
  }

  /** Do I hold the task? Pre-pickup: owner in my replica and my lease has not lapsed. Post-pickup: owner. */
  holds(taskId: string): boolean {
    const rec = this.replica.getTask(taskId);
    if (!rec || rec.owner !== this.id) return false;
    if (rec.state === 'PICKED_UP' || rec.state === 'DELIVERED') return true;
    if (isPrePickup(rec)) return this.tracker.has(taskId) && !this.tracker.lapsed(taskId, this.now);
    return false;
  }

  /**
   * Asynchronous depot arbitration: the first call sends PICKUP_REQ with my record to the origin depot and returns
   * PENDING; later calls return PENDING until the depot answered (resent every `pickupRetryS`), then the answer once.
   * Without an answer for a lease length the drone abandons the pickup (TASK_TAKEN).
   */
  pickup(taskId: string): PickupResult {
    const now = this.now;
    const rec = this.replica.getTask(taskId);
    const pp = this.pickups.get(taskId);
    if (this.handedOut.has(taskId)) {
      // a second pickup of a parcel already handed over is refused, as on the global board (the controller retries
      // its pickup when it cannot plan the delivery leg; the baselines then drop the task)
      this.forget(taskId);
      return 'TASK_TAKEN';
    }
    if (rec && rec.owner === this.id && rec.state === 'PICKED_UP') {
      // the grant reached me (answer or gossip)
      this.pickups.delete(taskId);
      this.tracker.markPickedUp(taskId);
      this.own.set(taskId, rec);
      this.handedOut.add(taskId);
      return 'PICKUP_GRANT';
    }
    if (pp?.result) {
      this.pickups.delete(taskId);
      if (pp.result === 'PICKUP_GRANT') this.handedOut.add(taskId);
      return pp.result;
    }
    if (!rec || rec.owner !== this.id || !isPrePickup(rec) || !this.holds(taskId)) {
      this.pickups.delete(taskId);
      return 'TASK_TAKEN';
    }
    if (!pp) {
      const n: PendingPickup = { epoch: rec.epoch, firstAt: now, lastSent: -Infinity, result: null };
      this.pickups.set(taskId, n);
      this.sendPickupReq(taskId, n, now);
      return 'PENDING';
    }
    if (now - pp.firstAt > rec.lease_s) {
      this.pickups.delete(taskId);
      this.emit({ type: 'pickup_timeout', agent: this.id, data: { task: taskId, node: this.id, waitedS: now - pp.firstAt } });
      return 'TASK_TAKEN';
    }
    return 'PENDING';
  }

  /** DELIVERED, written by the owner at the drop (beats ABORTED on the rank tie). */
  complete(taskId: string, lateS: number): void {
    const rec = this.replica.getTask(taskId) ?? this.own.get(taskId);
    if (!rec || rec.owner !== this.id || (rec.state !== 'PICKED_UP' && rec.state !== 'ABORTED')) return;
    const d: TaskRecord = { ...rec, state: 'DELIVERED' };
    if (this.write(d)) {
      this.gossip.urgent();
      this.emit({ type: 'board_delivered', agent: this.id, data: { task: taskId, late: Math.max(0, lateS), node: this.id } });
    }
    this.forget(taskId);
  }

  /** Owner gives the task back: pre-pickup re-open (owner release), or ABORTED for a parcel I carry back. */
  release(taskId: string, reason = 'released'): void {
    const rec = this.replica.getTask(taskId);
    if (rec && rec.owner === this.id) {
      if (isPrePickup(rec)) {
        const r = releaseRecord(rec, this.id);
        if (r && this.write(r)) this.emit({ type: 'board_released', agent: this.id, data: { task: taskId, epoch: r.epoch, node: this.id } });
      } else if (rec.state === 'PICKED_UP') {
        const a: TaskRecord = { ...rec, state: 'ABORTED' };
        if (this.write(a)) this.emit({ type: 'board_aborted', agent: this.id, data: { task: taskId, reason, node: this.id } });
      }
      this.gossip.urgent();
    }
    this.forget(taskId);
  }

  /** DISTRESS broadcast (the drone announces its own failure; receivers declare it failed at once). */
  distress(reason: string): void {
    const p: DistressPayload = { reason };
    this.port.send({ type: 'DISTRESS', src: this.id, dst: '*', t_send: this.now, payload: p });
  }

  /** Controller-facing task object rebuilt from my replica (lease expressed on my local clock). */
  taskOf(taskId: string): Task | undefined {
    return this.replica.toTask(taskId);
  }

  /** Integrated health of a peer in my view. */
  healthOf(peer: NodeId): PeerHealth {
    return this.health.get(peer) ?? 'ALIVE';
  }

  // ---- internals --------------------------------------------------------------------------------------------

  private forget(taskId: string): void {
    this.tracker.drop(taskId);
    this.own.delete(taskId);
    this.optimistic.delete(taskId);
    this.pickups.delete(taskId);
  }

  /** Local write + bookkeeping. False when the record is not strictly greater than mine (nothing changes). */
  private write(rec: TaskRecord): boolean {
    if (!this.replica.writeTask(rec, this.now)) return false;
    const w = this.replica.getTask(rec.task_id)!;
    if (w.owner === this.id) this.own.set(rec.task_id, w);
    this.onWrite(w, this.id);
    return true;
  }

  private sendPickupReq(taskId: string, pp: PendingPickup, now: number): void {
    const rec = this.replica.getTask(taskId);
    if (!rec) return;
    pp.lastSent = now;
    const payload: PickupReqPayload = { task: rec, epoch: pp.epoch };
    this.port.send({ type: 'PICKUP_REQ', src: this.id, dst: rec.origin_depot, t_send: now, payload });
  }

  private onPickupAnswer(type: 'PICKUP_GRANT' | 'TASK_TAKEN', from: NodeId, a: PickupAnswerPayload): void {
    if (typeof a.task_id !== 'string') return;
    const now = this.now;
    if (a.record && isTaskRecord(a.record) && a.record.task_id === a.task_id) {
      const out = this.replica.mergeTask(a.record, now);
      if (out !== 'unchanged') this.onMerged({ tasks: [{ task_id: a.task_id, outcome: out }], status: [], shards: [] });
    }
    const pp = this.pickups.get(a.task_id);
    if (!pp || pp.result !== null) return;
    const rec = this.replica.getTask(a.task_id);
    if (type === 'PICKUP_GRANT' && rec && rec.state === 'PICKED_UP' && rec.owner === this.id) {
      pp.result = 'PICKUP_GRANT';
      this.tracker.markPickedUp(a.task_id);
      this.own.set(a.task_id, rec);
    } else if (type === 'TASK_TAKEN') {
      pp.result = 'TASK_TAKEN';
      this.tracker.drop(a.task_id);
      this.own.delete(a.task_id);
      this.optimistic.delete(a.task_id);
      this.emit({ type: 'pickup_refused', agent: this.id, data: { task: a.task_id, depot: from, reason: a.reason ?? null, node: this.id } });
    }
  }

  /** After a gossip merge: urgent arrivals, peer evidence, failure-quorum reports, lost / confirmed ownership. */
  private onMerged(res: DeltaMergeResult): void {
    const now = this.now;
    for (const m of res.tasks) {
      const rec = this.replica.getTask(m.task_id)!;
      if (m.outcome === 'inserted' && rec.priority === 1) this.urgentCount++;
      const held = this.own.get(m.task_id);
      if (!held) continue;
      if (rec.owner === this.id && rec.state === 'PICKED_UP' && isPrePickup(held)) {
        // the depot's grant reached me by gossip before (or instead of) its answer
        this.tracker.markPickedUp(m.task_id);
        this.own.set(m.task_id, rec);
        const pp = this.pickups.get(m.task_id);
        if (pp && pp.result === null) pp.result = 'PICKUP_GRANT';
        continue;
      }
      const r = resolveAfterMerge(held, rec, this.id);
      if (r.action === 'keep') {
        if (r.reassert) {
          if (this.write(r.reassert)) this.gossip.urgent();
        }
        else if (rec.owner === this.id) this.own.set(m.task_id, rec);
        continue;
      }
      const ev = r.event;
      this.emit({
        type: 'duplicate_resolved',
        agent: this.id,
        data: { task: ev.taskId, stage: ev.stage, reason: ev.reason, winner: ev.winner, duplicate: ev.duplicate, heldEpoch: ev.heldEpoch, mergedEpoch: ev.mergedEpoch, mergedState: ev.mergedState, node: this.id },
      });
      if (r.action === 'drop') this.forget(m.task_id);
      // 'divert' (post-pickup, impossible with one granting depot): keep carrying; the depot's grant decides
    }
    for (const id of res.status) {
      if (this.isDepot(id) || id === this.id) continue;
      this.fd.heardIndirect(id, now);
      const st = this.replica.getStatus(id);
      if (st) {
        this.locate(id, st.pos, now);
        if (st.endurance_s !== undefined) this.fd.setEndurance(id, st.endurance_s, now);
      }
      for (const target of st?.suspects ?? []) {
        if (target === this.id || this.isDepot(target)) continue;
        if (!this.statusFresh(target, now)) this.fd.reportUnreachable(id, target, now);
      }
    }
  }

  private locate(id: NodeId, pos: Vec3, at: number): void {
    const l = this.located.get(id);
    if (l && l.at > at) return;
    this.located.set(id, { pos: { x: pos.x, y: pos.y, z: pos.z }, at });
  }

  private statusFresh(id: NodeId, now: number): boolean {
    const t = this.replica.statusSeenAt(id);
    return t !== undefined && now - t <= this.cfg.reachWindowS;
  }

  /** Peers: drones heard by beacon or gossip. Integrated health, events, own UNREACHABLE reports, probes. */
  private stepHealth(now: number): void {
    const peers = new Set<NodeId>(this.fd.knownPeers());
    for (const id of this.replica.statusIdList()) if (id !== this.id && !this.isDepot(id)) peers.add(id);
    this.fd.update(now);
    const suspects: NodeId[] = [];
    for (const p of [...peers].sort(byId)) {
      const h = this.integrated(p, now);
      // a failure-quorum vote only from an observer that expected to hear the peer (not one it merely left)
      if (h === 'UNREACHABLE' && this.expects(p, now)) {
        suspects.push(p);
        this.fd.reportUnreachable(this.id, p, now);
      }
      const prev = this.health.get(p) ?? 'ALIVE';
      if (h !== prev) {
        this.health.set(p, h);
        const type = h === 'ALIVE' ? 'peer_alive' : h === 'SUSPECT' ? 'peer_suspect' : h === 'UNREACHABLE' ? 'peer_unreachable' : 'peer_failed';
        const data: Record<string, unknown> = { peer: p, from: prev, node: this.id };
        if (h === 'DECLARED_FAILED') {
          data.reason = this.fd.declared(p, now);
          if (data.reason === 'quorum') data.observers = this.fd.declaredBy(p);
        }
        this.emit({ type, agent: this.id, data });
      }
    }
    this.suspects = suspects;
    for (const pr of this.fd.probesToSend(now, (t) => this.integrated(t, now) !== 'ALIVE' && this.integrated(t, now) !== 'DECLARED_FAILED')) {
      const payload: ProbePayload = { target: pr.target };
      for (const via of pr.via) this.port.send({ type: 'PROBE', src: this.id, dst: via, t_send: now, payload });
    }
  }

  private integrated(p: NodeId, now: number): PeerHealth {
    const h = this.fd.health(p, now);
    if (h === 'DECLARED_FAILED') return h;
    if (h === 'ALIVE' || this.statusFresh(p, now)) return 'ALIVE';
    return h;
  }

  private publishStatus(now: number): void {
    this.lastStatus = now;
    const reach = this.view.reachable().length;
    const mode: DroneMode = reach <= 1 && this.view.knownFleet().length > 1 ? 'SOLO' : !quorumHolds(this.view) ? 'PARTITIONED' : this.suspects.length ? 'DEGRADED' : 'CONNECTED';
    const bundle = this.tracker.held().concat([...this.own.keys()].filter((id) => !this.tracker.has(id) && this.own.get(id)!.state === 'PICKED_UP'));
    const st: DroneStatusRecord = {
      drone_id: this.id,
      seq: ++this.statusSeq,
      pos: { x: round1(this.body.pos.x), y: round1(this.body.pos.y), z: round1(this.body.pos.z) },
      soc: Math.round(this.body.battery * 10) / 10,
      mode,
      bundle: [...new Set(bundle)].sort(byId),
      t_local: Math.round(now * 1000) / 1000,
    };
    if (this.suspects.length) st.suspects = [...this.suspects];
    if (this.body.enduranceS !== undefined && Number.isFinite(this.body.enduranceS)) st.endurance_s = Math.ceil(this.body.enduranceS);
    this.replica.writeStatus(st, now);
  }

  /**
   * STRICT: lease the home depot's catchment shards; renew every lease_s / 3; log grants and losses. Delegation
   * (REQ-OWN-005, design section 6): while charging or outside its home catchment the drone neither requests nor
   * keeps the leases: it hands them back (`holder = null`, renew + 1, written by the depot) so the next requester
   * gets them at once instead of after a full lease period.
   */
  private stepShardLeases(now: number): void {
    const held = this.shards.heldShards(now);
    for (const s of this.heldShardSet) if (!held.includes(s)) this.emit({ type: 'shard_lease_lost', agent: this.id, data: { shard: s, node: this.id } });
    this.heldShardSet = held;
    if (!this.homeShards.length || !this.depotIds.has(this.homeDepot)) return;
    const away = this.body.charging === true || (this.body.shard !== undefined && !this.homeShards.includes(this.body.shard));
    if (away) {
      const handBack: ShardLeaseRecord[] = [];
      for (const s of held) {
        const h = this.shards.handBack(s);
        if (h) {
          handBack.push(h);
          this.handedBackAt.set(s, now);
        }
      }
      if (handBack.length) {
        this.heldShardSet = [];
        const payload: ShardLeasePayload = { handBack, shards: [] };
        this.port.send({ type: 'SHARD_LEASE', src: this.id, dst: this.homeDepot, t_send: now, payload });
        this.emit({ type: 'shard_lease_handed_back', agent: this.id, data: { shards: handBack.map((h) => h.shard), reason: this.body.charging ? 'charging' : 'left_catchment', node: this.id } });
      }
      return;
    }
    if (now - this.lastShardReq < this.cfg.shardLease.leaseS / 3) return;
    this.lastShardReq = now;
    for (const s of this.homeShards) this.shards.requested(s, now);
    const payload: ShardLeasePayload = { shards: [...this.homeShards] };
    this.port.send({ type: 'SHARD_LEASE', src: this.id, dst: this.homeDepot, t_send: now, payload });
  }

  private onShardAnswer(p: ShardLeasePayload): void {
    if (!Array.isArray(p.leases) || typeof p.t_req !== 'number') return;
    const now = this.now;
    for (const l of p.leases) {
      if (!isShardLeaseRecord(l)) continue;
      if (p.t_req <= (this.handedBackAt.get(l.shard) ?? -Infinity)) {
        this.replica.mergeShard(l, now);
        continue;
      }
      const before = this.shards.holds(l.shard, now);
      this.shards.onAnswer(l, p.t_req);
      this.replica.mergeShard(l, now);
      if (!before && this.shards.holds(l.shard, now)) {
        this.heldShardSet = [...new Set([...this.heldShardSet, l.shard])].sort(byId);
        this.emit({ type: 'shard_lease_granted', agent: this.id, data: { shard: l.shard, epoch: l.epoch, depot: l.depot, node: this.id } });
      }
    }
  }

  private makeView(): FleetView {
    const self = this;
    return {
      me: this.id,
      nowLocal: () => self.now,
      reachable(): readonly NodeId[] {
        const now = self.now;
        if (self.reachCache && self.reachCache.at === now) return self.reachCache.ids;
        const out = [self.id];
        for (const id of self.replica.statusIdList()) {
          if (id === self.id || self.isDepot(id)) continue;
          if (self.statusFresh(id, now)) out.push(id);
        }
        out.sort(byId);
        self.reachCache = { at: now, ids: out };
        return out;
      },
      knownFleet(): readonly NodeId[] {
        // the configured fleet roster (or, without one, every drone ever seen) minus DECLARED_FAILED ones. No recency
        // horizon: a side that has not heard the others for a while is still a minority (Decision 19).
        const now = self.now;
        const ids = new Set<NodeId>([self.id]);
        for (const id of self.roster ? self.roster() : self.replica.statusIdList()) if (!self.isDepot(id)) ids.add(id);
        const out: NodeId[] = [];
        for (const id of ids) if (id === self.id || self.fd.health(id, now) !== 'DECLARED_FAILED') out.push(id);
        return out.sort(byId);
      },
      shardLease(shard: string): { lease: ShardLeaseRecord; live: boolean } | null {
        const l = self.replica.getShard(shard);
        if (!l) return null;
        const seen = self.replica.shardSeenAt(shard) ?? -Infinity;
        const p = self.cfg.shardLease;
        return { lease: l, live: l.holder !== null && self.now - seen <= observerBoundS(l.lease_s, p.driftMargin, p.graceS) };
      },
      optimisticClaims: () => self.optimistic.size,
    };
  }
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

