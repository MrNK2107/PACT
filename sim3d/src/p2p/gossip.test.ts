import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import type { Envelope, TaskRecord } from './contracts';
import { GossipEngine } from './gossip';
import { mergeTask, Replica, taskKey } from './replica';
import { FakeNet, mkTaskRecord } from './testing/fakeNet';
import { P2P_DEFAULTS } from './contracts';

interface Node {
  id: string;
  rep: Replica;
  g: GossipEngine;
}

interface ClusterOpts {
  seed: number;
  n: number;
  loss: number;
  latencyTicks: [number, number];
  radius: number;
  dt?: number;
  basePeriodS?: number;
}

class Cluster {
  readonly net: FakeNet;
  readonly nodes: Node[];
  readonly byId = new Map<string, Node>();
  readonly pos: Map<string, { x: number; y: number }>;
  readonly rng: Rng;
  /** Every accepted local write, for the pure-fold reference. */
  readonly writes: TaskRecord[] = [];
  private nextTask = 0;

  constructor(o: ClusterOpts) {
    this.rng = new Rng(o.seed);
    this.net = new FakeNet({ seed: o.seed ^ 0x6e657477, loss: o.loss, latencyTicks: o.latencyTicks, dt: o.dt ?? 0.1 });
    const ids = Array.from({ length: o.n }, (_, i) => `N${String(i + 1).padStart(2, '0')}`);
    this.pos = FakeNet.randomGeometric(this.net, ids, o.radius, this.rng);
    this.nodes = ids.map((id) => {
      const rep = new Replica(id);
      const g = new GossipEngine(id, rep, this.net.clock(), (env) => this.net.send(env), { basePeriodS: o.basePeriodS ?? 1 });
      return { id, rep, g };
    });
    for (const n of this.nodes) this.byId.set(n.id, n);
  }

  get now(): number {
    return this.net.time;
  }

  tick(write?: () => void): void {
    for (const { to, env } of this.net.advance()) this.byId.get(to)!.g.onMessage(env);
    write?.();
    for (const n of this.nodes) n.g.step();
  }

  write(node: Node, rec: TaskRecord, urgent = false): boolean {
    const ok = node.rep.writeTask(rec, this.now);
    if (ok) {
      this.writes.push(rec);
      if (urgent) node.g.urgent();
    }
    return ok;
  }

  createTask(node: Node): string {
    const id = `D1:${String(++this.nextTask).padStart(8, '0')}:0000`;
    this.write(node, mkTaskRecord(id), true);
    return id;
  }

  /** One random protocol-shaped write by `node` on a task it knows (claim, renew, commit, pickup, deliver, re-open). */
  randomWrite(node: Node): void {
    const ids = node.rep.taskIdList();
    if (ids.length === 0 || this.rng.chance(0.15)) {
      this.createTask(node);
      return;
    }
    const cur = node.rep.getTask(this.rng.pick(ids))!;
    const me = node.id;
    let next: TaskRecord | null = null;
    switch (cur.state) {
      case 'UNASSIGNED':
        next = { ...cur, state: 'CLAIMED', epoch: cur.epoch + 1, owner: me, renew: 0, bid: -this.rng.int(1, 9), lease_s: 20 };
        break;
      case 'CLAIMED':
      case 'COMMITTED':
        if (cur.owner === me) {
          const r = this.rng.next();
          next = r < 0.4 ? { ...cur, renew: cur.renew + 1 } : r < 0.7 ? { ...cur, state: 'COMMITTED' } : { ...cur, state: 'PICKED_UP' };
        } else if (this.rng.chance(0.3)) {
          next = { ...cur, state: 'UNASSIGNED', epoch: cur.epoch + 1, owner: null, renew: 0, bid: null, lease_s: 0 };
        }
        break;
      case 'PICKED_UP':
        next = { ...cur, state: this.rng.chance(0.85) ? 'DELIVERED' : 'ABORTED' };
        break;
      default:
        break;
    }
    if (next) this.write(node, next, next.state === 'CLAIMED');
  }

  /** Pure fold of every write with mergeTask, sorted by id. */
  fold(): TaskRecord[] {
    const m = new Map<string, TaskRecord>();
    for (const w of this.writes) m.set(w.task_id, m.has(w.task_id) ? mergeTask(m.get(w.task_id)!, w) : w);
    return [...m.keys()].sort().map((id) => m.get(id)!);
  }

  keysOf(n: Node): string {
    return JSON.stringify(n.rep.tasks().map((t) => [t.task_id, taskKey(t)]));
  }

  converged(): boolean {
    const k0 = this.keysOf(this.nodes[0]);
    return this.nodes.every((n) => this.keysOf(n) === k0);
  }

  /** Ticks until every replica holds identical task keys, or -1 after `maxTicks`. */
  runUntilConverged(maxTicks: number): number {
    for (let t = 0; t <= maxTicks; t++) {
      if (this.converged()) return t;
      this.tick();
    }
    return -1;
  }

  totals() {
    const c = { pushes: 0, digests: 0, replies: 0, messages: 0, recordsSent: 0, received: 0 };
    for (const n of this.nodes) for (const k of Object.keys(c) as (keyof typeof c)[]) c[k] += n.g.counters[k];
    return { ...c, net: { ...this.net.stats } };
  }
}

/** TC-04 scenario: random writes for `writeS`, then stop; returns rounds (base periods) to converge. */
function tc04(seed: number) {
  const c = new Cluster({ seed, n: 16, loss: 0.4, latencyTicks: [1, 3], radius: 0.4 });
  const writeTicks = 300; // 30 s at dt = 0.1
  for (let t = 0; t < writeTicks; t++) {
    c.tick(() => {
      if (c.rng.chance(0.5)) c.randomWrite(c.rng.pick(c.nodes));
    });
  }
  const ticks = c.runUntilConverged(2000);
  return { c, ticks, rounds: ticks < 0 ? Infinity : (ticks * c.net.dt) / 1 };
}

describe('TC-04: delta gossip over a lossy random-geometric mesh', () => {
  it('16 nodes, 40 % loss, 100-300 ms latency: replicas converge within a bounded number of rounds once writes stop', () => {
    const rounds: number[] = [];
    for (let seed = 1; seed <= 20; seed++) {
      const { c, ticks, rounds: r } = tc04(seed);
      expect(ticks).toBeGreaterThanOrEqual(0);
      expect(c.writes.length).toBeGreaterThan(50);
      // converged state is the pure fold of every write
      for (const n of c.nodes) expect(n.rep.tasks()).toEqual(c.fold());
      rounds.push(r);
    }
    console.log(`[TC-04] rounds to converge after writes stop (seeds 1..20): ${rounds.map((r) => r.toFixed(1)).join(', ')}`);
    expect(Math.max(...rounds)).toBeLessThanOrEqual(10);
  });

  it('adaptive period: halves while busy, backs off to 4 x base when quiet; urgent() pushes at once', () => {
    const net = new FakeNet({ seed: 1 });
    net.link('A', 'B');
    const rep = new Replica('A');
    const sent: Omit<Envelope, 'v' | 'seq'>[] = [];
    const g = new GossipEngine('A', rep, net.clock(), (e) => sent.push(e), { basePeriodS: 1, phaseS: 0 });
    g.step(); // t = 0: first push slot, nothing dirty
    expect(g.period).toBe(1);
    for (let i = 0; i < 400; i++) {
      net.advance();
      g.step();
    }
    expect(g.period).toBe(4);
    const before = g.counters.pushes;
    rep.writeTask(mkTaskRecord('t1'), net.time);
    g.urgent();
    net.advance();
    g.step();
    expect(g.counters.pushes).toBe(before + 1);
    expect(g.period).toBe(2);
    expect(sent.filter((e) => e.type === 'GOSSIP_DIGEST').length).toBeGreaterThan(5);
    // a quiet tick does not push an empty delta
    const n = sent.length;
    g.urgent();
    net.advance();
    g.step();
    expect(sent.length).toBe(n);
  });

  it('ignores unknown message types, foreign unicasts and unknown payload fields', () => {
    const rep = new Replica('A');
    const sent: unknown[] = [];
    const g = new GossipEngine('A', rep, { nowLocal: () => 0 }, (e) => sent.push(e));
    const env = (over: Partial<Envelope>): Envelope => ({ v: 1, type: 'GOSSIP_DELTA', src: 'B', dst: '*', seq: 1, t_send: 0, payload: {}, ...over });
    g.onMessage(env({ type: 'HEARTBEAT', payload: { tasks: [mkTaskRecord('x')] } }));
    g.onMessage(env({ dst: 'C', payload: { tasks: [mkTaskRecord('y')] } }));
    g.onMessage(env({ payload: { tasks: [mkTaskRecord('z')], extra: 42, status: 'nope' } }));
    expect(rep.taskIdList()).toEqual(['z']);
    expect(sent).toEqual([]);
  });

  it('determinism: the same seed gives identical message counts and replicas', () => {
    const a = tc04(11);
    const b = tc04(11);
    expect(a.ticks).toBe(b.ticks);
    expect(a.c.totals()).toEqual(b.c.totals());
    expect(JSON.stringify(a.c.nodes.map((n) => n.rep.snapshot()))).toBe(JSON.stringify(b.c.nodes.map((n) => n.rep.snapshot())));
  });

  it('message load: pushes bounded by 1 / minPeriod; quiet mesh costs only the slow digest cadence', () => {
    const { c } = tc04(12);
    const n = c.nodes.length;
    const perMin = (x: number, s: number) => (x / n / s) * 60;
    const busyS = c.net.time;
    const busy = c.totals();
    for (let t = 0; t < 100; t++) c.tick(); // let acceleration lapse
    const before = c.totals();
    for (let t = 0; t < 600; t++) c.tick();
    const after = c.totals();
    const quiet = perMin(after.messages - before.messages, 60);
    console.log(
      `[TC-04] gossip msgs/node/min while writing 5 writes/s fleet-wide: pushes ${perMin(busy.pushes, busyS).toFixed(1)}, ` +
        `digests ${perMin(busy.digests, busyS).toFixed(1)}, replies ${perMin(busy.replies, busyS).toFixed(1)}; quiet total ${quiet.toFixed(1)}`,
    );
    expect(c.converged()).toBe(true);
    expect(after.pushes).toBe(before.pushes);
    expect(quiet).toBeLessThanOrEqual(60 / (5 * 1) + 1); // one digest per digestEvery x base period
    expect(perMin(busy.pushes, busyS)).toBeLessThanOrEqual(60 / P2P_DEFAULTS.gossipMinPeriodS + 10); // + urgent claims
  });
});

describe('AT-10 shape: partition, independent writes, heal, converge (I6)', () => {
  function at10(seed: number, loss: number) {
    const c = new Cluster({ seed, n: 16, loss, latencyTicks: [1, 3], radius: 0.4 });
    const left = c.nodes.filter((n) => c.pos.get(n.id)!.x < 0.5);
    const right = c.nodes.filter((n) => c.pos.get(n.id)!.x >= 0.5);
    // shared tasks known on both sides before the split
    const shared = Array.from({ length: 6 }, () => c.createTask(c.rng.pick(c.nodes)));
    expect(c.runUntilConverged(600)).toBeGreaterThanOrEqual(0);
    c.net.partition([left.map((n) => n.id), right.map((n) => n.id)]);
    // conflicting same-epoch claims on every shared task, one per side
    for (const id of shared) {
      for (const side of [left, right]) {
        const n = c.rng.pick(side);
        const cur = n.rep.getTask(id)!;
        c.write(n, { ...cur, state: 'CLAIMED', epoch: cur.epoch + 1, owner: n.id, renew: 0, bid: -1, lease_s: 20 }, true);
      }
    }
    for (let t = 0; t < 600; t++) {
      c.tick(() => {
        if (c.rng.chance(0.4)) c.randomWrite(c.rng.pick(c.rng.chance(0.5) ? left : right));
      });
    }
    expect(c.converged()).toBe(false);
    c.net.partition(null);
    const ticks = c.runUntilConverged(Math.round(60 / c.net.dt));
    return { c, ticks, shared, left, right };
  }

  it(`converges within T_converge = ${P2P_DEFAULTS.convergeS} s of the heal at the default period; state = pure fold`, () => {
    const secs: number[] = [];
    for (let seed = 21; seed <= 40; seed++) {
      const { c, ticks, shared, left, right } = at10(seed, 0.2);
      expect(left.length).toBeGreaterThan(0);
      expect(right.length).toBeGreaterThan(0);
      expect(ticks).toBeGreaterThanOrEqual(0);
      secs.push(ticks * c.net.dt);
      const fold = c.fold();
      for (const n of c.nodes) expect(n.rep.tasks()).toEqual(fold);
      // conflicting claims resolved to the same (lower-id) owner everywhere, epochs never went back
      for (const id of shared) expect(new Set(c.nodes.map((n) => n.rep.getTask(id)!.owner)).size).toBe(1);
    }
    console.log(`[AT-10] seconds to converge after heal, 20 % loss (seeds 21..40): ${secs.map((s) => s.toFixed(1)).join(', ')}`);
    expect(Math.max(...secs)).toBeLessThanOrEqual(P2P_DEFAULTS.convergeS);
  });

  it('also converges within T_converge after a heal at 40 % loss', () => {
    const secs: number[] = [];
    for (let seed = 41; seed <= 60; seed++) {
      const { c, ticks } = at10(seed, 0.4);
      expect(ticks).toBeGreaterThanOrEqual(0);
      secs.push(ticks * c.net.dt);
      for (const n of c.nodes) expect(n.rep.tasks()).toEqual(c.fold());
    }
    console.log(`[AT-10] seconds to converge after heal, 40 % loss (seeds 41..60): ${secs.map((s) => s.toFixed(1)).join(', ')}`);
    expect(Math.max(...secs)).toBeLessThanOrEqual(P2P_DEFAULTS.convergeS);
  });
});
