/**
 * In-memory test network for P2P unit tests (not used by the simulator; src/net/Network.ts is the real model).
 * Seeded loss, latency in whole ticks, explicit or random-geometric adjacency, partitions. Deterministic: one RNG
 * draw for loss then one for latency per (message, receiver) candidate, receivers sorted by id; delivery order
 * (deliverTick, sendSeq, receiver).
 */
import { Rng } from '../../world/rng';
import type { Clock, Envelope, NodeId, TaskRecord } from '../contracts';

export interface FakeNetOptions {
  seed: number;
  /** Per-copy loss probability. */
  loss?: number;
  /** Latency in ticks, inclusive range (>= 1 means the earliest delivery is the next tick). */
  latencyTicks?: [number, number];
  /** Tick length in seconds. */
  dt?: number;
}

interface InFlight {
  at: number;
  sendSeq: number;
  to: NodeId;
  env: Envelope;
}

export class FakeNet {
  readonly rng: Rng;
  readonly dt: number;
  loss: number;
  latencyTicks: [number, number];
  tick = 0;
  private readonly ids: NodeId[] = [];
  private readonly adj = new Map<NodeId, Set<NodeId>>();
  private readonly seqs = new Map<NodeId, number>();
  private groupOf: Map<NodeId, number> | null = null;
  private queue: InFlight[] = [];
  private sendSeq = 0;
  /** Messages handed to `send`, copies delivered, copies dropped (loss). */
  readonly stats = { sent: 0, delivered: 0, dropped: 0 };

  constructor(opts: FakeNetOptions) {
    this.rng = new Rng(opts.seed);
    this.loss = opts.loss ?? 0;
    this.latencyTicks = opts.latencyTicks ?? [1, 1];
    this.dt = opts.dt ?? 0.1;
  }

  get time(): number {
    return this.tick * this.dt;
  }

  /** Simulation-time clock (optionally drifting, ppm). */
  clock(ppm = 0): Clock {
    return { nowLocal: () => this.tick * this.dt * (1 + ppm * 1e-6) };
  }

  addNode(id: NodeId): void {
    if (this.adj.has(id)) return;
    this.ids.push(id);
    this.ids.sort();
    this.adj.set(id, new Set());
    this.seqs.set(id, 0);
  }

  link(a: NodeId, b: NodeId): void {
    this.addNode(a);
    this.addNode(b);
    this.adj.get(a)!.add(b);
    this.adj.get(b)!.add(a);
  }

  nodes(): readonly NodeId[] {
    return this.ids;
  }

  neighbours(id: NodeId): NodeId[] {
    return [...(this.adj.get(id) ?? [])].sort();
  }

  /** Nodes are in the cut-off groups given; unlisted nodes join group 0. `null` heals. */
  partition(groups: NodeId[][] | null): void {
    if (groups === null) {
      this.groupOf = null;
      return;
    }
    const g = new Map<NodeId, number>();
    groups.forEach((members, i) => members.forEach((m) => g.set(m, i)));
    this.groupOf = g;
  }

  private cut(a: NodeId, b: NodeId): boolean {
    if (this.groupOf === null) return false;
    return (this.groupOf.get(a) ?? 0) !== (this.groupOf.get(b) ?? 0);
  }

  /** Send now (at the current tick). Broadcast goes to every neighbour; unicast only to a neighbour. */
  send(env: Omit<Envelope, 'v' | 'seq'>): void {
    const seq = (this.seqs.get(env.src) ?? 0) + 1;
    this.seqs.set(env.src, seq);
    const full: Envelope = { v: 1, seq, ...env };
    this.stats.sent++;
    const sendSeq = ++this.sendSeq;
    const targets = env.dst === '*' ? this.neighbours(env.src) : this.adj.get(env.src)?.has(env.dst) ? [env.dst] : [];
    for (const to of targets) {
      if (this.cut(env.src, to)) continue;
      if (this.rng.next() < this.loss) {
        this.stats.dropped++;
        continue;
      }
      const [lo, hi] = this.latencyTicks;
      const lat = lo + Math.floor(this.rng.next() * (hi - lo + 1));
      this.queue.push({ at: this.tick + Math.max(1, lat), sendSeq, to, env: full });
    }
  }

  /** Advance one tick and return the copies due, in delivery order. */
  advance(): { to: NodeId; env: Envelope }[] {
    this.tick++;
    const due: InFlight[] = [];
    const rest: InFlight[] = [];
    for (const m of this.queue) (m.at <= this.tick ? due : rest).push(m);
    this.queue = rest;
    due.sort((a, b) => a.at - b.at || a.sendSeq - b.sendSeq || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
    this.stats.delivered += due.length;
    return due.map((m) => ({ to: m.to, env: m.env }));
  }

  /** Is the current graph (ignoring partitions) connected? */
  connected(): boolean {
    if (this.ids.length === 0) return true;
    const seen = new Set<NodeId>([this.ids[0]]);
    const stack = [this.ids[0]];
    while (stack.length) for (const n of this.neighbours(stack.pop()!)) if (!seen.has(n)) (seen.add(n), stack.push(n));
    return seen.size === this.ids.length;
  }

  /**
   * Random-geometric graph: `n` nodes uniform in a unit square (seeded), linked when closer than `radius`.
   * Retries with fresh positions (same RNG stream) until connected, at most `tries` times. Returns positions.
   */
  static randomGeometric(
    net: FakeNet,
    ids: NodeId[],
    radius: number,
    rng: Rng,
    tries = 200,
  ): Map<NodeId, { x: number; y: number }> {
    for (let k = 0; k < tries; k++) {
      const pos = new Map(ids.map((id) => [id, { x: rng.next(), y: rng.next() }] as const));
      const sorted = [...ids].sort();
      const ok = (() => {
        const adj = new Map(sorted.map((id) => [id, [] as NodeId[]]));
        for (let i = 0; i < sorted.length; i++)
          for (let j = i + 1; j < sorted.length; j++) {
            const a = pos.get(sorted[i])!;
            const b = pos.get(sorted[j])!;
            if (Math.hypot(a.x - b.x, a.y - b.y) < radius) (adj.get(sorted[i])!.push(sorted[j]), adj.get(sorted[j])!.push(sorted[i]));
          }
        const seen = new Set([sorted[0]]);
        const st = [sorted[0]];
        while (st.length) for (const n of adj.get(st.pop()!)!) if (!seen.has(n)) (seen.add(n), st.push(n));
        if (seen.size !== sorted.length) return false;
        for (const id of sorted) net.addNode(id);
        for (const [a, ns] of adj) for (const b of ns) if (a < b) net.link(a, b);
        return true;
      })();
      if (ok) return pos;
    }
    throw new Error('randomGeometric: no connected graph found');
  }
}

/** Test fixture: a task record with defaults. */
export function mkTaskRecord(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: id,
    origin_depot: 'D1',
    pickup: { x: 0, y: 0, z: 0 },
    drop: { x: 100, y: 0, z: 100 },
    priority: 2,
    deadline: 900,
    weight_kg: 1,
    shard: 'H-64-64',
    state: 'UNASSIGNED',
    epoch: 0,
    owner: null,
    bid: null,
    renew: 0,
    lease_s: 0,
    created_at: 0,
    dropId: 'DP-0001',
    type: 'residential',
    scripted: false,
    ...over,
  };
}
