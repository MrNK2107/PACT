/**
 * TC-04: delta gossip with digest anti-entropy and an adaptive period (docs/P2P_DESIGN.md section 5,
 * PRD REQ-STATE-003).
 *
 * - Delta push: when the push timer fires (local clock), broadcast GOSSIP_DELTA with every record whose merge
 *   order changed since the previous push (own writes and relayed ones). Empty deltas are not sent.
 * - Adaptive period: halves (floor `minPeriodS`) after a non-empty push, doubles (cap `maxFactor` x base) after 3
 *   quiet periods. `urgent()` pushes at the next `step()` regardless of the timer. Records learned from a peer pull
 *   the next push forward to `now + minPeriodS` so relays cross multi-hop meshes quickly.
 * - Digest pull: every `digestEvery x basePeriodS` local seconds (fixed cadence, independent of the adaptive period,
 *   so a quiet mesh still heals within T_converge), broadcast GOSSIP_DIGEST. While anti-entropy finds divergence (a
 *   unicast reply taught the node something, it answered a digest with a difference, or was asked for records) it digests every base period for the
 *   next `digestEvery` periods (anti-entropy acceleration; costs messages only while replicas differ).
 *   A receiver answers with a unicast GOSSIP_DELTA carrying what the sender lacks plus `want` (ids it lacks); the sender then answers `want` with a
 *   unicast GOSSIP_DELTA. One round trip converges a pair.
 *
 * Deterministic: time only from the injected `Clock`, no randomness. Ignores unknown message types and fields.
 */
import { P2P_DEFAULTS, type Clock, type Envelope, type GossipDeltaPayload, type NodeId, type ReplicaDelta, type ReplicaDigest } from './contracts';
import { isEmptyDelta, isEmptyWant, type DeltaMergeResult, type DigestOptions, type Replica } from './replica';

export type { GossipDeltaPayload } from './contracts';

/**
 * GOSSIP_DIGEST payload. `ask` (integration, optional): the peers that should answer; absent means every receiver
 * answers (TC-04 behaviour). Limits the replies of a broadcast digest from "every neighbour" to a few.
 */
export type GossipDigestPayload = ReplicaDigest & { ask?: NodeId[] };

export type GossipSend = (env: Omit<Envelope, 'v' | 'seq'>) => void;

export interface GossipOptions {
  /** Base gossip period in local seconds (PRD `gossip_period_s`, default 1). */
  basePeriodS?: number;
  digestEvery?: number;
  minPeriodS?: number;
  maxFactor?: number;
  /** Quiet periods before the period doubles. */
  quietPeriods?: number;
  /** Offset of the first push / digest (local seconds), to de-synchronise nodes. Default: derived from the id. */
  phaseS?: number;
  /**
   * Anti-entropy settle window (local s, default 0): records changed more recently are left out of digest answers and
   * reported with their previous key in digests (`DigestOptions.settleS`), so digests crossing pushes cost no reply.
   */
  settleS?: number;
  /** Include drone status in digests (default true). Off: statuses travel by push only. */
  digestStatus?: boolean;
  /**
   * Answerers per digest (default 0 = every receiver answers). With n > 0 the digest names n peers heard recently:
   * first the peers that (re)appeared since they were last asked (a heal, a newcomer), then round-robin.
   */
  askPeers?: number;
  /**
   * Speed up digests after answering someone else's digest or want (default true, TC-04). Off: only being behind
   * myself (a unicast reply taught me something, or a digest showed I lack records) speeds my digests up.
   */
  accelerateOnAnswer?: boolean;
  /** Called after a received delta changed the replica (e.g. to invalidate views, resolve duplicates). */
  onMerged?: (res: DeltaMergeResult, from: NodeId) => void;
}

export interface GossipCounters {
  /** Broadcast GOSSIP_DELTA messages sent. */
  pushes: number;
  /** GOSSIP_DIGEST messages sent. */
  digests: number;
  /** Unicast GOSSIP_DELTA replies sent (digest answers and want answers). */
  replies: number;
  /** Total messages sent. */
  messages: number;
  /** Task + status + shard records sent, over all messages. */
  recordsSent: number;
  /** Messages received and handled. */
  received: number;
}

/** Deterministic fraction in [0, 1) from a node id (FNV-1a). */
function idFraction(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 4294967296;
}

const recCount = (d: ReplicaDelta) => d.tasks.length + d.status.length + d.shards.length;

export class GossipEngine {
  readonly basePeriodS: number;
  readonly minPeriodS: number;
  readonly maxPeriodS: number;
  readonly digestIntervalS: number;
  readonly counters: GossipCounters = { pushes: 0, digests: 0, replies: 0, messages: 0, recordsSent: 0, received: 0 };

  private periodS: number;
  private quiet = 0;
  private readonly quietLimit: number;
  private nextPushAt: number | null = null;
  private nextDigestAt: number | null = null;
  /** Fast digest cadence (one base period) until this local time. */
  private fastDigestUntil = -Infinity;
  private urgentPending = false;
  private readonly phaseS: number;
  private readonly digestOpts: DigestOptions;
  private readonly askPeers: number;
  private readonly accelerateOnAnswer: boolean;
  /** Gossip peers: last heard, (re)appearance time after a gap, last time asked to answer my digest. */
  private readonly peers = new Map<NodeId, { last: number; since: number; asked: number }>();
  private rr = 0;
  private readonly onMerged?: (res: DeltaMergeResult, from: NodeId) => void;

  constructor(
    readonly id: NodeId,
    readonly replica: Replica,
    readonly clock: Clock,
    private readonly send: GossipSend,
    opts: GossipOptions = {},
  ) {
    this.basePeriodS = opts.basePeriodS ?? 1;
    this.minPeriodS = Math.min(opts.minPeriodS ?? P2P_DEFAULTS.gossipMinPeriodS, this.basePeriodS);
    this.maxPeriodS = this.basePeriodS * (opts.maxFactor ?? P2P_DEFAULTS.gossipMaxFactor);
    this.digestIntervalS = this.basePeriodS * (opts.digestEvery ?? P2P_DEFAULTS.digestEvery);
    this.quietLimit = opts.quietPeriods ?? 3;
    this.periodS = this.basePeriodS;
    this.phaseS = opts.phaseS ?? idFraction(id) * this.basePeriodS;
    this.onMerged = opts.onMerged;
    this.digestOpts = { settleS: opts.settleS ?? 0, status: opts.digestStatus ?? true };
    this.askPeers = opts.askPeers ?? 0;
    this.accelerateOnAnswer = opts.accelerateOnAnswer ?? true;
  }

  /** Current adaptive push period (local seconds). */
  get period(): number {
    return this.periodS;
  }

  /** Push the dirty records at the next `step()`, regardless of the period (claims, pickups, priority-1 intake). */
  urgent(): void {
    this.urgentPending = true;
  }

  /** Call once per tick. */
  step(): void {
    const now = this.clock.nowLocal();
    if (this.nextPushAt === null) {
      this.nextPushAt = now + this.phaseS;
      this.nextDigestAt = now + this.phaseS + this.digestIntervalS;
    }
    if (now >= this.nextPushAt) {
      const sent = this.push(now);
      if (sent) {
        this.periodS = Math.max(this.minPeriodS, this.periodS / 2);
        this.quiet = 0;
      } else if (++this.quiet >= this.quietLimit) {
        this.periodS = Math.min(this.maxPeriodS, this.periodS * 2);
        this.quiet = 0;
      }
      this.nextPushAt = now + this.periodS;
      this.urgentPending = false;
    } else if (this.urgentPending) {
      this.urgentPending = false;
      if (this.push(now)) {
        this.periodS = Math.max(this.minPeriodS, this.periodS / 2);
        this.quiet = 0;
      }
    }
    if (now >= this.nextDigestAt!) {
      const dg: GossipDigestPayload = this.replica.digest(now, this.digestOpts);
      const ask = this.chooseAsk(now);
      if (ask) dg.ask = ask;
      this.sendMsg('GOSSIP_DIGEST', '*', now, dg);
      this.counters.digests++;
      this.nextDigestAt = now + (now < this.fastDigestUntil ? this.basePeriodS : this.digestIntervalS);
    }
  }

  /** Handle one received envelope (other types are ignored). */
  onMessage(env: Envelope): void {
    if (!env || env.src === this.id) return;
    if (env.dst !== '*' && env.dst !== this.id) return;
    if (env.type !== 'GOSSIP_DELTA' && env.type !== 'GOSSIP_DIGEST') return;
    const payload = env.payload as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') return;
    const now = this.clock.nowLocal();
    this.counters.received++;
    this.heard(env.src, now);

    if (env.type === 'GOSSIP_DELTA') {
      const res = this.replica.mergeDelta(payload as Partial<ReplicaDelta>, now);
      if (res.tasks.length + res.status.length + res.shards.length > 0) {
        // relay soon: epidemic spread across hops
        if (this.nextPushAt !== null) this.nextPushAt = Math.min(this.nextPushAt, now + this.minPeriodS);
        // anti-entropy found something the pushes missed: speed up digests (pushes are normal traffic)
        if (env.dst !== '*') this.diverged(now);
        this.onMerged?.(res, env.src);
      }
      const want = (payload as Partial<GossipDeltaPayload>).want;
      if (want && typeof want === 'object') {
        if (this.accelerateOnAnswer) this.diverged(now);
        const d = this.replica.recordsFor(want);
        if (!isEmptyDelta(d)) {
          this.sendMsg('GOSSIP_DELTA', env.src, now, d);
          this.counters.replies++;
        }
      }
      return;
    }

    // GOSSIP_DIGEST
    const ask = (payload as { ask?: unknown }).ask;
    if (Array.isArray(ask) && !ask.includes(this.id)) return;
    const ans = this.replica.answerDigest(payload as Partial<ReplicaDigest>, now, this.digestOpts);
    const emptyWant = isEmptyWant(ans.want);
    if (isEmptyDelta(ans.delta) && emptyWant) return;
    if (this.accelerateOnAnswer || !emptyWant) this.diverged(now);
    const reply: GossipDeltaPayload = emptyWant ? ans.delta : { ...ans.delta, want: ans.want };
    this.sendMsg('GOSSIP_DELTA', env.src, now, reply);
    this.counters.replies++;
  }

  private heard(src: NodeId, now: number): void {
    const p = this.peers.get(src);
    const gap = 3 * this.maxPeriodS;
    if (!p) this.peers.set(src, { last: now, since: now, asked: -Infinity });
    else {
      if (now - p.last > gap) p.since = now;
      p.last = now;
    }
  }

  /** Peers to answer my next digest (null: everyone may answer). */
  private chooseAsk(now: number): NodeId[] | null {
    if (this.askPeers <= 0) return null;
    const window = 2 * this.digestIntervalS;
    const live = [...this.peers.keys()].filter((id) => now - this.peers.get(id)!.last <= window).sort();
    if (!live.length) return null;
    const out: NodeId[] = [];
    for (const id of live) {
      const p = this.peers.get(id)!;
      if (p.since > p.asked && out.length < this.askPeers) out.push(id);
    }
    for (let k = 0; k < live.length && out.length < this.askPeers; k++) {
      const id = live[(this.rr + k) % live.length];
      if (!out.includes(id)) out.push(id);
    }
    this.rr = (this.rr + this.askPeers) % Math.max(1, live.length);
    for (const id of out) this.peers.get(id)!.asked = now;
    return out.sort();
  }

  /** Anti-entropy saw a difference: digest every base period for the next `digestEvery` periods (and the next
   * digest within one base period). A converged mesh falls back to the slow cadence by itself. */
  private diverged(now: number): void {
    this.fastDigestUntil = now + this.digestIntervalS;
    if (this.nextDigestAt !== null) this.nextDigestAt = Math.min(this.nextDigestAt, now + this.basePeriodS);
  }

  private push(now: number): boolean {
    if (!this.replica.hasDirty()) return false;
    const d = this.replica.takeDelta(now);
    if (isEmptyDelta(d)) return false;
    this.sendMsg('GOSSIP_DELTA', '*', now, d);
    this.counters.pushes++;
    return true;
  }

  private sendMsg(type: 'GOSSIP_DELTA' | 'GOSSIP_DIGEST', dst: NodeId | '*', now: number, payload: unknown): void {
    this.counters.messages++;
    if (type === 'GOSSIP_DELTA') this.counters.recordsSent += recCount(payload as ReplicaDelta);
    this.send({ type, src: this.id, dst, t_send: now, payload });
  }
}
