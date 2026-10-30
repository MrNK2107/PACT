import { describe, expect, it } from 'vitest';
import type { Task } from '../sim/Task';
import type { DroneStatusRecord, Envelope, NodeId, PartitionPolicyName, TaskRecord } from './contracts';
import { DepotNode } from './DepotNode';
import { defaultP2PConfig, type NodeEvent, type P2PConfig } from './node';
import { P2PNode, type DroneBodyView } from './P2PNode';
import { ReplicaBoard } from './ReplicaBoard';
import { taskFromRecord } from './replica';
import { FakeNet, mkTaskRecord } from './testing/fakeNet';

/**
 * Unit tests of the integration nodes (TC-07 drone side, TC-08 depot) over the in-memory FakeNet: one tick = 0.05 s,
 * one-tick latency, full mesh unless cut. ReplicaBoard is driven exactly as the controller drives it.
 */

const DT = 0.05;

class Harness {
  readonly net: FakeNet;
  readonly drones = new Map<NodeId, { node: P2PNode; board: ReplicaBoard; drift: number }>();
  readonly depots = new Map<NodeId, DepotNode>();
  readonly events: (NodeEvent & { t: number })[] = [];
  readonly writes: TaskRecord[] = [];
  /** Envelopes dropped on purpose (type filter), e.g. to lose depot answers. */
  drop: ((env: Envelope, to: NodeId) => boolean) | null = null;
  readonly cfg: P2PConfig;
  /** Per-drone body handed to `preStep` (default: at the origin, 90 %). */
  readonly bodies = new Map<NodeId, DroneBodyView>();
  /** Drones send HEARTBEAT beacons (with their position) every 0.1 s, as the controller does. */
  beacons = false;
  /** Killed drones: they neither step nor send nor receive any more. */
  readonly dead = new Set<NodeId>();
  private ticks = 0;

  constructor(policy: PartitionPolicyName = 'QUORUM', over: Partial<P2PConfig> = {}) {
    this.net = new FakeNet({ seed: 7, latencyTicks: [1, 1], dt: DT });
    this.cfg = { ...defaultP2PConfig({ policy }), ...over };
  }

  private sink = (e: NodeEvent) => this.events.push({ ...e, t: this.net.time });
  private onWrite = (r: TaskRecord) => this.writes.push(r);

  private link(id: NodeId): void {
    this.net.addNode(id);
    for (const other of this.net.nodes()) if (other !== id) this.net.link(id, other);
  }

  depot(id: NodeId, catchmentShards: string[] = [], ppm = 0): DepotNode {
    this.link(id);
    const d = new DepotNode({
      id,
      clock: this.net.clock(ppm),
      port: { send: (env) => this.net.send(env), receive: () => [] },
      cfg: this.cfg,
      pos: { x: 0, y: 25, z: 0 },
      catchmentShards,
      depotIds: ['D1', 'D2'],
      events: this.sink,
      onWrite: this.onWrite,
    });
    this.depots.set(id, d);
    return d;
  }

  drone(id: NodeId, homeDepot = 'D1', ppm = 0): { node: P2PNode; board: ReplicaBoard } {
    this.link(id);
    const node = new P2PNode({
      id,
      clock: this.net.clock(ppm),
      port: { send: (env) => this.net.send(env), receive: () => [] },
      cfg: this.cfg,
      depots: [
        { id: 'D1', catchmentShards: ['S1', 'S2'] },
        { id: 'D2', catchmentShards: ['S3'] },
      ],
      homeDepot,
      roster: () => [...this.drones.keys()],
      events: this.sink,
      onWrite: this.onWrite,
    });
    const board = new ReplicaBoard(node);
    this.drones.set(id, { node, board, drift: ppm });
    return { node, board };
  }

  /** One engine-like tick: deliver, depots step, drones preStep / (controller) / step. */
  tick(control?: () => void): void {
    for (const { to, env } of this.net.advance()) {
      if (this.drop?.(env, to) || this.dead.has(to) || this.dead.has(env.src)) continue;
      const beaconPos = env.type === 'HEARTBEAT' ? (env.payload as { pos: DroneBodyView['pos'] }).pos : null;
      const d = this.depots.get(to);
      if (d) beaconPos ? d.onBeacon(env.src, beaconPos) : d.onEnvelope(env);
      const n = this.drones.get(to);
      if (n) beaconPos ? n.node.onBeacon(env.src, beaconPos) : n.node.onEnvelope(env);
    }
    for (const id of [...this.depots.keys()].sort()) this.depots.get(id)!.step();
    const live = [...this.drones.keys()].sort().filter((id) => !this.dead.has(id));
    for (const id of live) this.drones.get(id)!.node.preStep(this.bodyOf(id));
    control?.();
    for (const id of live) this.drones.get(id)!.node.step();
    if (this.beacons && this.ticks % 2 === 0) for (const id of live) this.net.send({ type: 'HEARTBEAT', src: id, dst: '*', t_send: this.net.time, payload: { pos: this.bodyOf(id).pos } });
    this.ticks++;
  }

  bodyOf(id: NodeId): DroneBodyView {
    let b = this.bodies.get(id);
    if (!b) this.bodies.set(id, (b = { pos: { x: 0, y: 0, z: 0 }, battery: 90 }));
    return b;
  }

  run(seconds: number, control?: () => void): void {
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) this.tick(control);
  }

  get now(): number {
    return this.net.time;
  }

  ev(type: string): (NodeEvent & { t: number })[] {
    return this.events.filter((e) => e.type === type);
  }
}

function task(id: string, over: Partial<TaskRecord> = {}): Task {
  return taskFromRecord(mkTaskRecord(id, { origin_depot: 'D1', shard: 'S1', ...over }), undefined);
}

describe('ReplicaBoard: claims (TC-07)', () => {
  it('open() lists UNASSIGNED records once gossip brought them and the origin depot is in contact; claim writes CLAIMED', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    h.drone('A02');
    d1.intake(task('T1'));
    h.run(3);
    expect(a.board.open().map((t) => t.task_id)).toEqual(['T1']);
    expect(a.board.claim('T1', 'A01', -1, h.now)).toBe(true);
    const rec = a.node.replica.getTask('T1')!;
    expect([rec.state, rec.owner, rec.epoch, rec.lease_s]).toEqual(['CLAIMED', 'A01', 1, h.cfg.lease.leaseTtlS]);
    expect(a.board.holds('T1', 'A01')).toBe(true);
    expect(a.board.open()).toEqual([]);
    h.run(1);
    expect(d1.replica.getTask('T1')!.owner).toBe('A01'); // the claim was pushed urgently
    expect(h.writes.some((w) => w.task_id === 'T1' && w.state === 'CLAIMED')).toBe(true);
  });

  it('never claims over CLAIMED / COMMITTED, even when the lease looks expired in its view', () => {
    const h = new Harness();
    h.depot('D1');
    const a = h.drone('A01');
    h.drone('A02');
    h.run(3);
    // a stale CLAIMED record by A02, expired in A01's view; its origin depot never hears of it (so never re-opens it)
    h.drop = (env, to) => to === 'D1' && env.type === 'GOSSIP_DELTA' && JSON.stringify(env.payload).includes('"T9"');
    a.node.replica.mergeTask(mkTaskRecord('T9', { origin_depot: 'D1', shard: 'S1', state: 'CLAIMED', epoch: 1, owner: 'A02', lease_s: 20 }), a.node.now);
    h.run(60);
    expect(a.node.now - a.node.replica.seenAt('T9')!).toBeGreaterThan(2 * h.cfg.lease.leaseTtlS);
    expect(a.board.claim('T9', 'A01', -1, h.now)).toBe(false);
    expect(a.board.open().map((t) => t.task_id)).not.toContain('T9');
    expect(a.node.replica.getTask('T9')!.state).toBe('CLAIMED');
  });

  it('no origin depot in contact: nothing to claim (it could neither arbitrate nor acknowledge the lease)', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    expect(a.board.open()).toHaveLength(1);
    h.net.partition([['D1'], ['A01']]);
    h.run(h.cfg.reachWindowS + 1.5);
    expect(a.board.open()).toEqual([]);
    expect(a.board.claim('T1', 'A01', -1, h.now)).toBe(false);
  });

  it('QUORUM: no new claim from a minority side', () => {
    const h = new Harness('QUORUM');
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    h.drone('A02');
    h.drone('A03');
    d1.intake(task('T1'));
    h.run(3);
    expect(a.board.open()).toHaveLength(1); // 3 of 3 reachable
    h.net.partition([['A01', 'D1'], ['A02', 'A03']]);
    h.run(h.cfg.reachWindowS + 1.5);
    expect(a.node.view.reachable()).toEqual(['A01']);
    expect(a.board.open()).toEqual([]);
    expect(a.board.claim('T1', 'A01', -1, h.now)).toBe(false);
  });

  /**
   * QUORUM membership is the configured fleet roster (minus DECLARED_FAILED), not "drones heard recently": otherwise a
   * minority side that never heard the others (boot-time split), or stopped hearing them long enough, would count
   * itself a majority and claim (split brain under the policy meant to prevent it; DECISIONS.md Decision 19).
   */
  function splitFleet(policy: PartitionPolicyName): { h: Harness; minority: P2PNode[]; majority: P2PNode[]; boards: Map<NodeId, ReplicaBoard> } {
    // engine-like detector: silence alone never declares a drone that may still be aloft (endurance bound, Decision 18)
    const base = defaultP2PConfig({ policy });
    const h = new Harness(policy, { failure: { params: base.failure.params, opts: { ...base.failure.opts, maxEnduranceS: 2400 } } });
    const d1 = h.depot('D1');
    const d2 = h.depot('D2');
    const boards = new Map<NodeId, ReplicaBoard>();
    const minority: P2PNode[] = [];
    const majority: P2PNode[] = [];
    for (const id of ['A01', 'A02']) {
      const x = h.drone(id, 'D1');
      minority.push(x.node);
      boards.set(id, x.board);
    }
    for (const id of ['A03', 'A04', 'A05', 'A06']) {
      const x = h.drone(id, 'D2');
      majority.push(x.node);
      boards.set(id, x.board);
    }
    d1.intake(task('T1'));
    d2.intake(task('T2', { origin_depot: 'D2', shard: 'S3' }));
    return { h, minority, majority, boards };
  }

  it('QUORUM, partition at boot {2 drones + D1} | {4 drones + D2}: the minority never claims, the majority does', () => {
    const { h, boards } = splitFleet('QUORUM');
    h.net.partition([['A01', 'A02', 'D1'], ['A03', 'A04', 'A05', 'A06', 'D2']]);
    for (let k = 0; k < 6; k++) {
      h.run(30); // 180 s in all: well past any membership horizon
      for (const id of ['A01', 'A02']) {
        expect(boards.get(id)!.open()).toEqual([]);
        expect(boards.get(id)!.claim('T1', id, -1, h.now)).toBe(false);
      }
    }
    expect(h.drones.get('A01')!.node.view.knownFleet()).toEqual(['A01', 'A02', 'A03', 'A04', 'A05', 'A06']);
    expect(boards.get('A03')!.open().map((t) => t.task_id)).toEqual(['T2']);
    expect(boards.get('A03')!.claim('T2', 'A03', -1, h.now)).toBe(true);
  });

  it('QUORUM, partition longer than 60 s after a healthy start: the minority still never claims', () => {
    const { h, boards } = splitFleet('QUORUM');
    h.run(5);
    h.net.partition([['A01', 'A02', 'D1'], ['A03', 'A04', 'A05', 'A06', 'D2']]);
    for (let k = 0; k < 8; k++) {
      h.run(20); // 160 s
      expect(boards.get('A01')!.claim('T1', 'A01', -1, h.now)).toBe(false);
    }
    expect(boards.get('A04')!.claim('T2', 'A04', -1, h.now)).toBe(true);
  });

  it('QUORUM: a DECLARED_FAILED drone leaves the roster count', () => {
    const { h } = splitFleet('QUORUM');
    h.run(3);
    const a = h.drones.get('A01')!.node;
    a.fd.onDistress('A06', a.now);
    expect(a.view.knownFleet()).toEqual(['A01', 'A02', 'A03', 'A04', 'A05']);
  });

  it('OPTIMISTIC_BOUNDED: one priority >= 2 claim without quorum, never a priority-1 one', () => {
    const h = new Harness('OPTIMISTIC_BOUNDED');
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    h.drone('A02');
    h.drone('A03');
    d1.intake(task('P2a', { priority: 2 }));
    d1.intake(task('P2b', { priority: 2 }));
    d1.intake(task('P1', { priority: 1 }));
    h.run(3);
    h.net.partition([['A01', 'D1'], ['A02', 'A03']]);
    h.run(h.cfg.reachWindowS + 1.5);
    expect(a.board.open().map((t) => t.task_id)).toEqual(['P2a', 'P2b']);
    expect(a.board.claim('P1', 'A01', -1, h.now)).toBe(false);
    expect(a.board.claim('P2a', 'A01', -1, h.now)).toBe(true);
    expect(a.node.view.optimisticClaims()).toBe(1);
    expect(a.board.claim('P2b', 'A01', -1, h.now)).toBe(false);
  });

  it('STRICT: claims only with a live shard lease held by a reachable drone; the catchment depot grants it', () => {
    const h = new Harness('STRICT');
    const d1 = h.depot('D1', ['S1', 'S2']);
    const a = h.drone('A01');
    const b = h.drone('A02');
    d1.intake(task('T1', { shard: 'S1' }));
    d1.intake(task('T3', { shard: 'S3' })); // D2's catchment: no D2 here, nobody holds S3
    h.run(5);
    const holder = d1.replica.getShard('S1')!.holder;
    expect(['A01', 'A02']).toContain(holder);
    expect(h.ev('shard_lease_granted').length).toBeGreaterThan(0);
    expect(a.board.open().map((t) => t.task_id)).toEqual(['T1']);
    expect(b.board.open().map((t) => t.task_id)).toEqual(['T1']);
    expect(a.board.claim('T3', 'A01', -1, h.now)).toBe(false);
  });

  it('lost merge (equal-epoch concurrent claims): the higher id drops the task with duplicate_resolved', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    const b = h.drone('A02');
    d1.intake(task('T1'));
    h.run(3);
    expect(b.board.claim('T1', 'A02', -2, h.now)).toBe(true);
    expect(a.board.claim('T1', 'A01', -1, h.now)).toBe(true);
    h.run(1);
    expect(a.board.holds('T1', 'A01')).toBe(true);
    expect(b.board.holds('T1', 'A02')).toBe(false);
    const dup = h.ev('duplicate_resolved');
    expect(dup.map((e) => [e.agent, e.data.stage, e.data.reason, e.data.winner])).toEqual([['A02', 'pre_pickup', 'outbid', 'A01']]);
  });
});

describe('ReplicaBoard: leases and zombie-stop (I3)', () => {
  it('renews every lease / 4, commits after t_commit, and holds while the origin depot acknowledges', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    h.run(60);
    expect(a.board.holds('T1', 'A01')).toBe(true);
    const rec = a.node.replica.getTask('T1')!;
    expect(rec.state).toBe('COMMITTED');
    expect(rec.renew).toBeGreaterThanOrEqual(11);
    const ack = d1.replica.getStatus('D1')!.acks!.T1;
    expect(ack[0]).toBe(1);
    expect(ack[1]).toBeGreaterThanOrEqual(rec.renew - 1);
    expect(h.ev('lease_expired')).toEqual([]);
  });

  it('without acknowledgements the owner stops (holds false) strictly before the depot re-opens', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    h.run(1);
    h.net.partition([['D1'], ['A01']]);
    let stopAt = -1;
    h.run(40, () => {
      if (stopAt < 0 && !a.board.holds('T1', 'A01')) stopAt = h.now;
    });
    const reopen = h.ev('lease_expired');
    expect(stopAt).toBeGreaterThan(0);
    expect(reopen).toHaveLength(1);
    expect(reopen[0].data.node).toBe('D1');
    expect(stopAt).toBeLessThan(reopen[0].t);
    expect(d1.replica.getTask('T1')!.state).toBe('UNASSIGNED');
    expect(d1.replica.getTask('T1')!.epoch).toBe(2);
  });
});

describe('ReplicaBoard: asynchronous pickup (TC-08)', () => {
  function claimed(h: Harness) {
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    h.run(1);
    return { d1, a };
  }

  it('PENDING until the depot grants; then the record is PICKED_UP everywhere and the lease is sticky', () => {
    const h = new Harness();
    const { d1, a } = claimed(h);
    expect(a.board.pickup('T1', 'A01', 1, h.now)).toBe('PENDING');
    let v = 'PENDING';
    for (let i = 0; i < 20 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('PICKUP_GRANT');
    expect(d1.replica.getTask('T1')!.state).toBe('PICKED_UP');
    expect(d1.grantOf('T1')).toEqual({ owner: 'A01', epoch: 1 });
    h.net.partition([['D1'], ['A01']]);
    h.run(60);
    expect(a.board.holds('T1', 'A01')).toBe(true); // post-pickup ownership never lapses
    expect(h.ev('lease_expired')).toEqual([]);
    // the global board refuses a second pickup of a parcel already handed over; so does the replica board
    expect(a.board.pickup('T1', 'A01', 1, h.now)).toBe('TASK_TAKEN');
  });

  it('a lost answer is resent after pickupRetryS and re-granted (grant memory, idempotent)', () => {
    const h = new Harness();
    const { d1, a } = claimed(h);
    let lost = 0;
    const t0 = h.now;
    // lose the first answer, and keep the depot's gossip of the PICKED_UP record away from the drone for 3 s
    h.drop = (env: Envelope, to: NodeId) => (env.type === 'PICKUP_GRANT' && lost++ === 0) || (to === 'A01' && env.type === 'GOSSIP_DELTA' && h.now < t0 + 3);
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    let reqs = 0;
    const origSend = h.net.send.bind(h.net);
    h.net.send = (env) => {
      if (env.type === 'PICKUP_REQ') reqs++;
      origSend(env);
    };
    for (let i = 0; i < 100 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('PICKUP_GRANT');
    expect(lost).toBeGreaterThanOrEqual(1);
    expect(h.now - t0).toBeGreaterThanOrEqual(h.cfg.pickupRetryS - DT);
    expect(reqs).toBeGreaterThanOrEqual(1);
    expect(d1.counters.grants).toBe(1);
    expect(h.ev('board_pickup_grant').filter((e) => e.data.regrant === true).length).toBeGreaterThanOrEqual(1);
  });

  it('TASK_TAKEN for the loser of a concurrent claim: the depot answers with its record and the drone drops it', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const b = h.drone('A02');
    const c = h.drone('A03');
    h.drone('A04');
    d1.intake(task('T1'));
    h.run(3);
    // A02 and A03 claim in the same tick (neither heard the other's bid); A03 hears no gossip for a while
    const t0 = h.now;
    h.drop = (env, to) => to === 'A03' && env.type === 'GOSSIP_DELTA' && h.now < t0 + 5;
    expect(b.board.claim('T1', 'A02', -1, h.now)).toBe(true);
    expect(c.board.claim('T1', 'A03', -1, h.now)).toBe(true);
    h.run(1);
    expect(c.board.holds('T1', 'A03')).toBe(true); // it has not learnt yet
    let v = c.board.pickup('T1', 'A03', 1, h.now);
    for (let i = 0; i < 40 && v === 'PENDING'; i++) {
      h.tick();
      v = c.board.pickup('T1', 'A03', 1, h.now);
    }
    expect(v).toBe('TASK_TAKEN');
    expect(c.board.holds('T1', 'A03')).toBe(false);
    expect(d1.counters.grants).toBe(0);
    expect(d1.counters.refusals).toBe(1);
    expect(h.ev('board_task_taken')[0].data.reason).toBe('not_owner');
    expect(h.ev('duplicate_resolved').map((e) => e.agent)).toEqual(['A03']);
  });

  it('no answer within a lease: the drone abandons the pickup', () => {
    const h = new Harness();
    const { a } = claimed(h);
    h.drop = (env) => env.type === 'PICKUP_REQ';
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    let n = 0;
    for (; n < 2000 && v === 'PENDING'; n++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('TASK_TAKEN');
    expect(h.ev('pickup_timeout')).toHaveLength(1);
  });
});

describe('DepotNode (TC-08)', () => {
  it('intake writes epoch 0 / UNASSIGNED and gossips it; priority 1 is pushed at once', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    h.run(2);
    expect(d1.intake(task('X', { origin_depot: 'D2' }))).toBeNull(); // not its task
    d1.intake(task('U1', { priority: 1 }));
    const urgentBefore = a.node.urgentCount;
    h.run(3 * DT);
    expect(a.node.replica.getTask('U1')).toBeDefined();
    expect(a.node.urgentCount).toBe(urgentBefore + 1);
  });

  it('arbitration: grants the current owner once; fences a record that out-ranks the grant', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    for (let i = 0; i < 20 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('PICKUP_GRANT');
    // a stale re-open + claim at epoch 3 reaches the depot (a single-writer violation from outside)
    const stale = { ...d1.replica.getTask('T1')!, state: 'CLAIMED' as const, epoch: 3, owner: 'A09', renew: 0 };
    d1.replica.mergeTask(stale, d1.now);
    h.tick();
    const r = d1.replica.getTask('T1')!;
    expect([r.state, r.owner, r.epoch]).toEqual(['PICKED_UP', 'A01', 3]);
    expect(d1.counters.fences).toBe(1);
    expect(h.ev('grant_fenced')).toHaveLength(1);
  });

  it('re-open after expiry: only by the origin depot, only after the observer bound, never after a grant', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const d2 = h.depot('D2');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    d1.intake(task('T2'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    h.run(1);
    const claimSeen = d1.replica.seenAt('T1')!;
    // the owner disappears (no renewals reach anyone)
    h.net.partition([['A01'], ['D1', 'D2']]);
    h.run(40);
    const re = h.ev('lease_expired');
    expect(re).toHaveLength(1);
    expect(re[0].data.node).toBe('D1');
    const bound = h.cfg.lease.leaseTtlS * (1 + h.cfg.lease.driftMargin) + h.cfg.lease.graceS;
    // the last renewal the depot saw is at most lease / 4 after the claim
    expect(re[0].t).toBeGreaterThan(claimSeen + bound);
    expect(d2.counters.reopens).toBe(0);
    expect(d1.counters.reopens).toBe(1);
  });

  it('DECLARED_FAILED of a carrier: ABORTED + exactly one replacement; cancelled if the parcel turns up delivered', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    h.drone('A02');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    for (let i = 0; i < 20 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('PICKUP_GRANT');
    // the carrier announces its own failure
    a.node.distress('test');
    h.run(2);
    h.run(30);
    const re = h.ev('task_reordered');
    expect(re).toHaveLength(1);
    expect(re[0].data).toMatchObject({ of: 'T1', task: 'T1:r1', node: 'D1' });
    expect(d1.replica.getTask('T1')!.state).toBe('ABORTED');
    expect(d1.replica.getTask('T1:r1')!.state).toBe('UNASSIGNED');
    expect(d1.counters.replacements).toBe(1);
    // ... yet the parcel arrives (DELIVERED beats ABORTED): the replacement, still unclaimed, is cancelled
    a.board.complete('T1', 'A01', h.now);
    h.run(3);
    expect(d1.replica.getTask('T1')!.state).toBe('DELIVERED');
    expect(d1.replica.getTask('T1:r1')!.state).toBe('ABORTED');
    expect(h.ev('replacement_cancelled')).toHaveLength(1);
    h.run(10);
    expect(d1.counters.replacements).toBe(1); // a cancelled replacement is never replaced
  });

  it('a parcel carried back (owner-written ABORTED): the origin depot orders one replacement', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    for (let i = 0; i < 20 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    a.board.release('T1', 'A01', h.now);
    h.run(3);
    expect(d1.replica.getTask('T1')!.state).toBe('ABORTED');
    expect(h.ev('task_reordered')).toHaveLength(1);
    h.run(5);
    expect(h.ev('task_reordered')).toHaveLength(1);
  });

  it('depot status carries the lease acks of its own pre-pickup tasks only', () => {
    const h = new Harness();
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    d1.intake(task('T1'));
    d1.intake(task('T2'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    h.run(8);
    const st = d1.replica.getStatus('D1') as DroneStatusRecord;
    expect(Object.keys(st.acks!)).toEqual(['T1']);
    expect(a.node.replica.getStatus('D1')!.acks!.T1[0]).toBe(1);
  });
});

describe('Failure handling with physical evidence (TC-09 hardening, design section 7)', () => {
  /** A-priori radio knowledge for the tests: 1 km nominal range everywhere, drones at most 20 m/s. */
  const EXPECT = { rangeM: () => 1000, maxSpeedMps: 20, margin: 0.8 };

  function fleet(over: Partial<P2PConfig> = {}) {
    const base = defaultP2PConfig({ policy: 'QUORUM' });
    const h = new Harness('QUORUM', { expect: EXPECT, failure: { params: base.failure.params, opts: { ...base.failure.opts, maxEnduranceS: 600 } }, ...over });
    h.beacons = true;
    const d1 = h.depot('D1');
    const a = h.drone('A01');
    const b = h.drone('A02');
    const c = h.drone('A03');
    h.bodyOf('A01').pos = { x: 100, y: 30, z: 0 };
    h.bodyOf('A02').pos = { x: -100, y: 30, z: 0 };
    h.bodyOf('A03').pos = { x: 0, y: 30, z: 120 };
    d1.intake(task('T1'));
    h.run(3);
    a.board.claim('T1', 'A01', -1, h.now);
    let v = a.board.pickup('T1', 'A01', 1, h.now);
    for (let i = 0; i < 20 && v === 'PENDING'; i++) {
      h.tick();
      v = a.board.pickup('T1', 'A01', 1, h.now);
    }
    expect(v).toBe('PICKUP_GRANT');
    h.run(2);
    return { h, d1, a, b, c };
  }

  const failedAt = (h: Harness, node: string, peer: string) => h.ev('peer_failed').filter((e) => e.data.node === node && e.data.peer === peer);

  it('a carrier that dies among observers that expected to hear it: quorum, and the depot re-orders at once (urgent)', () => {
    const { h, d1 } = fleet();
    const tKill = h.now;
    h.dead.add('A01');
    h.run(20);
    const pf = failedAt(h, 'D1', 'A01');
    expect(pf).toHaveLength(1);
    expect(pf[0].data.reason).toBe('quorum');
    expect((pf[0].data.observers as string[]).length).toBeGreaterThanOrEqual(2);
    expect(pf[0].data.carrying).toEqual(['T1']);
    expect(pf[0].t - tKill).toBeLessThan(10);
    const re = h.ev('task_reordered');
    expect(re).toHaveLength(1);
    // the replacement is ordered in the same depot step as the declaration (no extra wait), never before it
    expect(re[0].t).toBe(pf[0].t);
    expect(re[0].data).toMatchObject({ of: 'T1', task: 'T1:r1', cause: 'declared_failed', peer: 'A01', declared: 'quorum', node: 'D1' });
    const r1 = d1.replica.getTask('T1:r1')!;
    expect(r1.priority).toBe(1);
    expect(r1.deadline).toBeGreaterThan(h.now);
  });

  it('a carrier that flew out of everyone\'s range is UNREACHABLE but never declared failed: nobody expected to hear it', () => {
    const { h } = fleet();
    h.bodyOf('A01').pos = { x: 5000, y: 30, z: 0 };
    h.run(2); // its beacons tell everyone where it went
    h.net.partition([['A01'], ['D1', 'A02', 'A03']]);
    h.run(120);
    expect(h.ev('peer_unreachable').some((e) => e.data.peer === 'A01')).toBe(true);
    expect(h.ev('peer_failed').filter((e) => e.data.peer === 'A01')).toEqual([]);
    expect(h.ev('task_reordered')).toEqual([]);
  });

  it('silence declares only past the endurance bound the drone itself reported (physical evidence)', () => {
    const { h } = fleet();
    h.bodyOf('A01').enduranceS = 90; // last status: 90 s of flight left
    h.bodyOf('A01').pos = { x: 5000, y: 30, z: 0 };
    h.run(2);
    const tCut = h.now;
    h.net.partition([['A01'], ['D1', 'A02', 'A03']]);
    h.run(120);
    const pf = failedAt(h, 'D1', 'A01');
    expect(pf).toHaveLength(1);
    expect(pf[0].data.reason).toBe('silence');
    // not before the endurance bound (90 s from its last status), even though tFailedS (60 s) passed earlier
    expect(pf[0].t - tCut).toBeGreaterThanOrEqual(88);
    expect(h.ev('task_reordered')).toHaveLength(1);
  });

  it('a suspected peer gets no new work: ReplicaBoard.suspected follows the failure detector', () => {
    const { h, a } = fleet();
    expect(a.board.suspected('A02')).toBe(false);
    h.net.partition([['A02'], ['D1', 'A01', 'A03']]);
    h.run(h.cfg.reachWindowS + 2);
    expect(a.board.suspected('A02')).toBe(true);
    expect(a.board.suspected('A03')).toBe(false);
    h.net.partition(null);
    h.run(3);
    expect(a.board.suspected('A02')).toBe(false);
  });
});

describe('Shard-lease delegation (REQ-OWN-005, design section 6)', () => {
  function strict() {
    const h = new Harness('STRICT');
    const d1 = h.depot('D1', ['S1', 'S2']);
    h.drone('A01');
    h.drone('A02');
    h.run(5);
    const holder = d1.replica.getShard('S1')!.holder!;
    expect(['A01', 'A02']).toContain(holder);
    return { h, d1, holder, other: holder === 'A01' ? 'A02' : 'A01' };
  }

  for (const why of ['charging', 'left_catchment'] as const) {
    it(`a holder ${why === 'charging' ? 'going to charge' : 'leaving its catchment'} hands the leases back; the next requester gets them within one request period`, () => {
      const { h, d1, holder, other } = strict();
      if (why === 'charging') h.bodyOf(holder).charging = true;
      else h.bodyOf(holder).shard = 'S3';
      const t0 = h.now;
      h.run(1);
      const hb = h.ev('shard_lease_handed_back');
      expect(hb).toHaveLength(1);
      expect(hb[0].data).toMatchObject({ shards: ['S1', 'S2'], reason: why, node: holder });
      expect(h.ev('shard_lease_released').map((e) => e.data.shard)).toEqual(['S1', 'S2']);
      expect(d1.replica.getShard('S1')!.holder).toBeNull();
      let regrantAt = -1;
      h.run(h.cfg.shardLease.leaseS, () => {
        if (regrantAt < 0 && d1.replica.getShard('S1')!.holder === other) regrantAt = h.now;
      });
      expect(regrantAt).toBeGreaterThan(0);
      // within one renewal cadence of the other drone, far below the lease period it would otherwise wait out
      expect(regrantAt - t0).toBeLessThanOrEqual(h.cfg.shardLease.leaseS / 3 + 1);
      // the away holder neither requests nor re-holds it meanwhile
      expect(d1.replica.getShard('S1')!.holder).toBe(other);
      expect(h.drones.get(holder)!.node.shards.holds('S1', h.now)).toBe(false);
    });
  }
});
