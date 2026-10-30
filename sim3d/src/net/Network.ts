import type { Envelope, MessageType, NetworkPort, NodeId } from '../p2p/contracts';
import type { RadioModel } from '../sim/Radio';
import { Rng } from '../world/rng';
import type { Vec3 } from '../world/types';

/**
 * Simulated radio network (TC-02, docs/P2P_DESIGN.md section 3). Replaces the old one-tick `MessageBus`.
 *
 * - Messages travel in PRD 9.1 envelopes; `dst` is `'*'` (broadcast to every node in range) or one node id.
 * - Reachability of a link a -> b is decided once, when the send is resolved: distance within
 *   `rangeM * radioRangeFactor(a, b)` and not cut by an open partition. Every reachable (message, receiver)
 *   candidate takes one loss draw; a surviving copy takes one latency draw, except beacons (HEARTBEAT), which
 *   use the lower latency bound with no draw. Draw order: messages in send order, receivers sorted by id.
 * - Loss combines network loss, dead-zone loss and per-node `link_loss` on transmit (sender) and receive.
 * - A copy is delivered at the first step whose time >= send time + latency, in (deliverAt, sendSeq, receiver)
 *   order. Delivery timing uses simulation time; the envelope's `t_send` is the sender's local clock.
 * - The network owns its RNG (`seed ^ NET_RNG_SALT`), so network draws never perturb workload or world draws.
 * - Depot backhaul (Decision 20): depot <-> depot copies travel over a wired / cellular link instead of the radio
 *   when the backhaul is enabled and neither end is cut (`backhaul_cut`): no range limit, no radio zones, no radio
 *   `link_loss`; still cut by a partition that puts the two depots in different groups. Same draw order (one loss
 *   draw per candidate, then one latency draw U(backhaul latency)). With the backhaul down a depot pair falls back
 *   to the radio. It is a transport between depots, not a coordinator: drones never use it directly.
 *
 * Environment side only: it knows positions and radio geometry, nothing about tasks, agents or safety
 * (invariant I4: the safety reflexes never read it).
 */

/** "netw": salt of the network's own RNG stream. */
export const NET_RNG_SALT = 0x6e657477;
/** Tolerance on delivery times (sim time advances by repeated float addition). */
const EPS = 1e-9;
/** Link-layer beacons: fixed minimum latency, no draw (Remote ID / ADS-B-like broadcasts). */
const BEACONS: ReadonlySet<MessageType> = new Set<MessageType>(['HEARTBEAT']);

export interface NetworkConfig {
  /** Base packet-loss probability per copy. */
  loss: number;
  /** Latency bounds [lo, hi] in ms; queued traffic draws U(lo, hi), beacons use lo. */
  latencyMs: [number, number];
  /** Nominal radio range (m) before dead-zone range factors. */
  rangeM: number;
  /** Scenario / world seed; the network's RNG is seeded with `seed ^ NET_RNG_SALT`. */
  seed: number;
  /** Depot <-> depot backhaul (absent: none). */
  backhaul?: BackhaulConfig;
}

export interface BackhaulConfig {
  enabled: boolean;
  /** Latency bounds [lo, hi] in ms, drawn U(lo, hi) for every copy. */
  latencyMs: [number, number];
  /** Loss probability per copy. */
  loss: number;
}

/** Backhaul traffic of one depot: copies it sent over the backhaul (one per receiving depot) and their bytes. */
export interface BackhaulStats {
  copies: number;
  bytes: number;
  delivered: number;
  lost: number;
}

export type NodeKind = 'drone' | 'depot';
export type LinkDir = 'both' | 'tx' | 'rx';

export interface TypeStats {
  sent: number;
  bytes: number;
  delivered: number;
}

/** Per-node traffic counters. Bytes are `JSON.stringify(payload).length`, a size proxy. */
export interface NodeStats {
  /** Messages this node sent (one per send, whatever the number of receivers). */
  sent: number;
  bytesSent: number;
  /** Copies of this node's messages delivered to receivers. */
  delivered: number;
  /** Copies of this node's messages lost to the loss draw (unreachable receivers are not counted). */
  lost: number;
  /** Copies this node received. */
  received: number;
  bytesReceived: number;
  byType: Partial<Record<MessageType, TypeStats>>;
}

/** A scripted window that closed in `advance` (the engine logs it). */
export type WindowEnd = { kind: 'partition' } | { kind: 'link_loss'; id: NodeId } | { kind: 'backhaul_cut'; depots: NodeId[] };

interface NodeEntry {
  id: NodeId;
  kind: NodeKind;
  pos: () => Vec3;
  inbox: Envelope[];
}

interface Outgoing {
  env: Envelope;
  pos: Vec3;
  tSim: number;
  sendSeq: number;
  bytes: number;
}

interface InFlight {
  env: Envelope;
  to: NodeId;
  deliverAt: number;
  sendSeq: number;
  bytes: number;
  backhaul: boolean;
}

interface LinkLoss {
  loss: number;
  dir: LinkDir;
  until?: number;
}

const emptyStats = (): NodeStats => ({ sent: 0, bytesSent: 0, delivered: 0, lost: 0, received: 0, bytesReceived: 0, byType: {} });

export class Network {
  private readonly rng: Rng;
  private readonly nodes = new Map<NodeId, NodeEntry>();
  private sortedIds: NodeId[] | null = [];
  /** Per-sender sequence numbers; survive unregister so a returning id never reuses a seq. */
  private readonly seqs = new Map<NodeId, number>();
  private readonly counters = new Map<NodeId, NodeStats>();
  private outgoing: Outgoing[] = [];
  /** In-flight copies, kept sorted by (deliverAt, sendSeq, to). */
  private queue: InFlight[] = [];
  private sendSeq = 0;
  private time = 0;
  private part: { groupOf: Map<NodeId, number>; groups: NodeId[][]; until?: number } | null = null;
  private readonly linkLoss = new Map<NodeId, LinkLoss>();
  /** Depots whose backhaul is cut, with the end of the cut (undefined: open-ended). */
  private readonly bhCut = new Map<NodeId, number | undefined>();
  private readonly bhStats = new Map<NodeId, BackhaulStats>();

  constructor(
    readonly config: NetworkConfig,
    private readonly radio?: RadioModel,
  ) {
    this.rng = new Rng(config.seed ^ NET_RNG_SALT);
  }

  /** Simulation time of the last `advance` / `step`. */
  get now(): number {
    return this.time;
  }

  // ---- registry ----------------------------------------------------------------------------------------

  /** Adds a node. `pos` is read when a send is resolved (drones move; depots pass a fixed point). */
  register(id: NodeId, kind: NodeKind, pos: () => Vec3): void {
    if (id === '*') throw new Error(`'*' is reserved for broadcast`);
    if (this.nodes.has(id)) throw new Error(`network node ${id} already registered`);
    this.nodes.set(id, { id, kind, pos, inbox: [] });
    this.sortedIds = null;
  }

  /** Removes a node: its inbox and the copies still in flight to it are dropped (its own sends still travel). */
  unregister(id: NodeId): void {
    if (!this.nodes.delete(id)) return;
    this.sortedIds = null;
    this.queue = this.queue.filter((q) => q.to !== id);
  }

  has(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  kindOf(id: NodeId): NodeKind | undefined {
    return this.nodes.get(id)?.kind;
  }

  /** Registered node ids, sorted. */
  ids(): readonly NodeId[] {
    if (!this.sortedIds) this.sortedIds = [...this.nodes.keys()].sort();
    return this.sortedIds;
  }

  /** The contract view of the network for one node (src is fixed to that node). */
  port(id: NodeId): NetworkPort {
    return {
      send: (env) => {
        if (env.src !== id) throw new Error(`port of ${id} cannot send as ${env.src}`);
        this.send(env);
      },
      receive: () => this.take(id),
    };
  }

  // ---- traffic -----------------------------------------------------------------------------------------

  /**
   * Queues a message from `env.src` (which must be registered). The sender's position is taken now; receivers,
   * loss and latency are resolved by `flush` (the engine flushes at the end of each tick). Returns the envelope
   * as it travels (with `v` and the sender's next `seq`). Unknown fields of `env` are not carried (NFR-3).
   */
  send(env: Omit<Envelope, 'v' | 'seq'>): Envelope {
    const node = this.nodes.get(env.src);
    if (!node) throw new Error(`network node ${env.src} is not registered`);
    const seq = (this.seqs.get(env.src) ?? 0) + 1;
    this.seqs.set(env.src, seq);
    const full: Envelope = { v: 1, type: env.type, src: env.src, dst: env.dst, seq, t_send: env.t_send, payload: env.payload };
    const bytes = JSON.stringify(env.payload ?? null).length;
    const st = this.statsFor(env.src);
    st.sent++;
    st.bytesSent += bytes;
    const bt = this.typeStats(st, env.type);
    bt.sent++;
    bt.bytes += bytes;
    const p = node.pos();
    this.outgoing.push({ env: full, pos: { x: p.x, y: p.y, z: p.z }, tSim: this.time, sendSeq: ++this.sendSeq, bytes });
    return full;
  }

  /** Resolves queued sends into in-flight copies (range, partition, loss and latency draws, in a fixed order). */
  flush(): void {
    if (!this.outgoing.length) return;
    const [lo, hi] = this.config.latencyMs;
    for (const o of this.outgoing) {
      const src = o.env.src;
      const receivers = o.env.dst === '*' ? this.ids() : this.nodes.has(o.env.dst) ? [o.env.dst] : [];
      for (const to of receivers) {
        if (to === src) continue;
        const rx = this.nodes.get(to)!;
        if (this.backhaulUp(src, to)) {
          const bh = this.config.backhaul!;
          const st = this.bhStatsFor(src);
          st.copies++;
          st.bytes += o.bytes;
          if (this.rng.next() < bh.loss) {
            this.statsFor(src).lost++;
            st.lost++;
            continue;
          }
          const [blo, bhi] = bh.latencyMs;
          const latMs = blo + (bhi - blo) * this.rng.next();
          this.queue.push({ env: o.env, to, deliverAt: o.tSim + latMs / 1000, sendSeq: o.sendSeq, bytes: o.bytes, backhaul: true });
          continue;
        }
        const rp = rx.pos();
        const d = Math.hypot(rp.x - o.pos.x, rp.y - o.pos.y, rp.z - o.pos.z);
        if (d > this.config.rangeM) continue;
        // dead zones only shrink the range (factor <= 1) and add loss; with no zone this is the plain disc model
        const fx = this.radio && this.radio.hasZones ? this.radio.link(o.pos, rp) : null;
        if (fx && d > this.config.rangeM * fx.rangeFactor) continue;
        if (this.cut(src, to)) continue;
        const loss = 1 - (1 - this.config.loss) * (1 - (fx ? fx.loss : 0)) * (1 - this.txLoss(src)) * (1 - this.rxLoss(to));
        if (this.rng.next() < loss) {
          this.statsFor(src).lost++;
          continue;
        }
        const latMs = BEACONS.has(o.env.type) ? lo : lo + (hi - lo) * this.rng.next();
        this.queue.push({ env: o.env, to, deliverAt: o.tSim + latMs / 1000, sendSeq: o.sendSeq, bytes: o.bytes, backhaul: false });
      }
    }
    this.outgoing = [];
    this.queue.sort((a, b) => a.deliverAt - b.deliverAt || a.sendSeq - b.sendSeq || (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  }

  /**
   * Moves the network clock to `now`: resolves sends still queued (state as of their tick) and closes scripted
   * windows that have elapsed. Returns the closed windows in a fixed order (partition first, then nodes by id).
   */
  advance(now: number): WindowEnd[] {
    this.flush();
    this.time = now;
    const ended: WindowEnd[] = [];
    if (this.part && this.part.until !== undefined && now >= this.part.until - EPS) {
      this.part = null;
      ended.push({ kind: 'partition' });
    }
    for (const id of [...this.linkLoss.keys()].sort()) {
      const l = this.linkLoss.get(id)!;
      if (l.until !== undefined && now >= l.until - EPS) {
        this.linkLoss.delete(id);
        ended.push({ kind: 'link_loss', id });
      }
    }
    const restored: NodeId[] = [];
    for (const id of [...this.bhCut.keys()].sort()) {
      const until = this.bhCut.get(id);
      if (until !== undefined && now >= until - EPS) {
        this.bhCut.delete(id);
        restored.push(id);
      }
    }
    if (restored.length) ended.push({ kind: 'backhaul_cut', depots: restored });
    return ended;
  }

  /** Delivers every in-flight copy due at the current time into its receiver's inbox. */
  deliver(): void {
    let n = 0;
    while (n < this.queue.length && this.queue[n].deliverAt <= this.time + EPS) {
      const q = this.queue[n++];
      const rx = this.nodes.get(q.to);
      if (!rx) continue;
      rx.inbox.push(q.env);
      const s = this.statsFor(q.env.src);
      s.delivered++;
      this.typeStats(s, q.env.type).delivered++;
      if (q.backhaul) this.bhStatsFor(q.env.src).delivered++;
      const r = this.statsFor(q.to);
      r.received++;
      r.bytesReceived += q.bytes;
    }
    if (n) this.queue.splice(0, n);
  }

  /** `advance(now)` then `deliver()`. */
  step(now: number): WindowEnd[] {
    const ended = this.advance(now);
    this.deliver();
    return ended;
  }

  /**
   * Takes the envelopes waiting for `id`, in delivery order. With `accept`, only matching envelopes are taken and
   * the rest stay queued (so legacy controller messages and P2P traffic can be read by different consumers).
   */
  take(id: NodeId, accept?: (env: Envelope) => boolean): Envelope[] {
    const node = this.nodes.get(id);
    if (!node || !node.inbox.length) return [];
    if (!accept) {
      const out = node.inbox;
      node.inbox = [];
      return out;
    }
    const out: Envelope[] = [];
    const keep: Envelope[] = [];
    for (const e of node.inbox) (accept(e) ? out : keep).push(e);
    node.inbox = keep;
    return out;
  }

  /** Copies in flight (resolved, not yet delivered). */
  get inFlight(): number {
    return this.queue.length;
  }

  // ---- link state --------------------------------------------------------------------------------------

  /**
   * Would a message from `a` reach `b` right now, loss draws aside? In range (with dead-zone range factors), not cut
   * by a partition, and not fully suppressed by `link_loss` (a's transmit side, b's receive side). For the viewer.
   */
  linkUp(a: NodeId, b: NodeId): boolean {
    const na = this.nodes.get(a);
    const nb = this.nodes.get(b);
    if (!na || !nb || a === b) return false;
    if (this.backhaulUp(a, b)) return true;
    if (this.cut(a, b) || this.txLoss(a) >= 1 || this.rxLoss(b) >= 1) return false;
    const pa = na.pos();
    const pb = nb.pos();
    const range = this.radio && this.radio.hasZones ? this.config.rangeM * this.radio.link(pa, pb).rangeFactor : this.config.rangeM;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z) <= range;
  }

  /**
   * Opens a partition window: links between different groups are cut until `until` (sim time; open-ended without
   * it). Nodes not listed join group 0. A newer partition replaces an open one (most recent fault wins). Returns
   * false (and changes nothing) if a listed id is not a registered node.
   */
  partition(groups: NodeId[][], until?: number): boolean {
    for (const g of groups) for (const id of g) if (!this.nodes.has(id)) return false;
    const groupOf = new Map<NodeId, number>();
    groups.forEach((g, i) => {
      for (const id of g) if (!groupOf.has(id)) groupOf.set(id, i);
    });
    this.part = { groupOf, groups: groups.map((g) => [...g]), until };
    return true;
  }

  /** Ends any open partition. */
  heal(): void {
    this.part = null;
  }

  /** Groups of the open partition, or null. */
  get partitionGroups(): readonly (readonly NodeId[])[] | null {
    return this.part ? this.part.groups : null;
  }

  /** End time (sim s) of the open partition; undefined when none is open or it is open-ended. For the viewer. */
  get partitionUntil(): number | undefined {
    return this.part?.until;
  }

  /**
   * Per-node loss on transmit and/or receive until `until` (asymmetric links, REQ-SIM-003). Replaces the node's
   * previous setting. Returns false for an unknown node.
   */
  setLinkLoss(id: NodeId, loss = 1, dir: LinkDir = 'both', until?: number): boolean {
    if (!this.nodes.has(id)) return false;
    this.linkLoss.set(id, { loss, dir, until });
    return true;
  }

  /**
   * Cuts the backhaul of the given depots (default: every registered depot) until `until` (open-ended without it).
   * Their radio is unaffected. Returns null (and changes nothing) for an id that is not a registered depot.
   */
  cutBackhaul(depots: readonly NodeId[] | undefined, until?: number): NodeId[] | null {
    const ids = depots ?? this.ids().filter((id) => this.nodes.get(id)!.kind === 'depot');
    for (const id of ids) if (this.nodes.get(id)?.kind !== 'depot') return null;
    for (const id of ids) this.bhCut.set(id, until);
    return [...ids].sort();
  }

  /** Is the a <-> b backhaul usable now (both depots, enabled, neither cut, not separated by a partition)? */
  backhaulUp(a: NodeId, b: NodeId): boolean {
    const bh = this.config.backhaul;
    if (!bh || !bh.enabled || a === b) return false;
    if (this.nodes.get(a)?.kind !== 'depot' || this.nodes.get(b)?.kind !== 'depot') return false;
    if (this.bhCut.has(a) || this.bhCut.has(b)) return false;
    return !this.cut(a, b);
  }

  /** Backhaul traffic a depot sent (zeros without any). */
  backhaulStats(id: NodeId): BackhaulStats {
    const s = this.bhStats.get(id);
    return s ? { ...s } : { copies: 0, bytes: 0, delivered: 0, lost: 0 };
  }

  private bhStatsFor(id: NodeId): BackhaulStats {
    let s = this.bhStats.get(id);
    if (!s) this.bhStats.set(id, (s = { copies: 0, bytes: 0, delivered: 0, lost: 0 }));
    return s;
  }

  private cut(a: NodeId, b: NodeId): boolean {
    if (!this.part) return false;
    return (this.part.groupOf.get(a) ?? 0) !== (this.part.groupOf.get(b) ?? 0);
  }

  private txLoss(id: NodeId): number {
    const l = this.linkLoss.get(id);
    return l && l.dir !== 'rx' ? l.loss : 0;
  }

  private rxLoss(id: NodeId): number {
    const l = this.linkLoss.get(id);
    return l && l.dir !== 'tx' ? l.loss : 0;
  }

  // ---- stats -------------------------------------------------------------------------------------------

  /** Counters of one node (zeros if it never sent or received). Kept after the node is unregistered. */
  stats(id: NodeId): NodeStats {
    const s = this.counters.get(id);
    return s ? { ...s, byType: Object.fromEntries(Object.entries(s.byType).map(([k, v]) => [k, { ...v }])) } : emptyStats();
  }

  /** Counters of every node that ever had traffic, sorted by id. */
  allStats(): { id: NodeId; stats: NodeStats }[] {
    return [...this.counters.keys()].sort().map((id) => ({ id, stats: this.stats(id) }));
  }

  /** Fleet totals (sum over nodes). */
  totals(): NodeStats {
    const t = emptyStats();
    for (const id of [...this.counters.keys()].sort()) {
      const s = this.counters.get(id)!;
      t.sent += s.sent;
      t.bytesSent += s.bytesSent;
      t.delivered += s.delivered;
      t.lost += s.lost;
      t.received += s.received;
      t.bytesReceived += s.bytesReceived;
      for (const [k, v] of Object.entries(s.byType) as [MessageType, TypeStats][]) {
        const tt = this.typeStats(t, k);
        tt.sent += v.sent;
        tt.bytes += v.bytes;
        tt.delivered += v.delivered;
      }
    }
    return t;
  }

  private statsFor(id: NodeId): NodeStats {
    let s = this.counters.get(id);
    if (!s) this.counters.set(id, (s = emptyStats()));
    return s;
  }

  private typeStats(s: NodeStats, type: MessageType): TypeStats {
    return (s.byType[type] ??= { sent: 0, bytes: 0, delivered: 0 });
  }
}
