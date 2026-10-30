/**
 * TC-09 failure detection (docs/P2P_DESIGN.md section 7, 03 section 3.6, PRD REQ-FAIL-001..003).
 *
 * Pure and engine-agnostic: every method takes the caller's local-clock time (`Clock.nowLocal()`); nothing here reads
 * a wall clock or a global RNG, and every iteration over peers is in sorted id order.
 *
 * - `PhiAccrual`: phi-accrual suspicion over heartbeat inter-arrival times (Hayashibara et al.; Akka's logistic
 *   approximation of the normal tail, evaluated in a numerically stable form).
 * - `FailureDetector`: one node's view of its peers. ALIVE / SUSPECT / UNREACHABLE from phi, indirect-probe
 *   bookkeeping, failure-quorum bookkeeping and the DECLARED_FAILED decision (distress, quorum, silence past both
 *   `tFailedS` and the peer's endurance bound). Which observers may vote (only those that expected to hear the peer)
 *   is the caller's decision (P2PNode / DepotNode).
 */
import type { FailureParams, NodeId, PeerHealth } from './contracts';
import { P2P_DEFAULTS } from './contracts';

// ---- phi accrual ----------------------------------------------------------------------------------------

/** ln(1 + e^x) without overflow / underflow. */
function softplus(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

/**
 * phi = -log10(P(next arrival later than `elapsed`)) with the arrival time ~ N(mean, std), the tail approximated by
 * the logistic function Akka uses: P ~= 1 / (1 + exp(z)), z = y (1.5976 + 0.070566 y^2), y = (elapsed - mean) / std.
 * -log10(1 / (1 + e^z)) = softplus(z) / ln 10, which is finite for every y and strictly increasing in `elapsed`.
 */
export function phiOf(elapsed: number, mean: number, std: number): number {
  const y = (elapsed - mean) / std;
  const z = y * (1.5976 + 0.070566 * y * y);
  return softplus(z) / Math.LN10;
}

export interface PhiAccrualOptions {
  /** Sliding window of inter-arrival samples (PRD section 15: 100). */
  windowSize: number;
  /** Floor of the standard deviation, seconds (0.1). */
  minStdS: number;
  /** Bootstrap estimate of the heartbeat interval, seconds (the sim beacons every `SIM.heartbeatPeriod` = 0.1 s). */
  expectedIntervalS: number;
  /** Extra tolerated pause added to the mean (Akka's acceptable-heartbeat-pause). 0 = the pure detector. */
  acceptablePauseS: number;
}

/**
 * Phi-accrual estimator for one peer. The window is seeded Akka-style with two synthetic intervals
 * (expected +- expected/4) at the first heartbeat, so phi is defined and conservative from the very first beacon;
 * real samples push the seeds out once the window is full.
 */
export class PhiAccrual {
  private readonly buf: number[];
  private head = 0;
  private count = 0;
  private sum = 0;
  private sumSq = 0;
  private sinceRecompute = 0;
  private last: number | null = null;

  constructor(private readonly opt: PhiAccrualOptions) {
    if (!(opt.windowSize >= 2)) throw new Error('PhiAccrual: windowSize must be >= 2');
    this.buf = new Array<number>(opt.windowSize).fill(0);
  }

  /** Local time of the last heartbeat, or null before the first one. */
  get lastArrival(): number | null {
    return this.last;
  }

  get samples(): number {
    return this.count;
  }

  /** Record a heartbeat arrival. Out-of-order / duplicate arrivals (t <= last) only count as evidence, not samples. */
  heartbeat(nowLocal: number): void {
    if (this.last === null) {
      const e = this.opt.expectedIntervalS;
      this.push(e - e / 4);
      this.push(e + e / 4);
      this.last = nowLocal;
      return;
    }
    if (nowLocal <= this.last) return;
    this.push(nowLocal - this.last);
    this.last = nowLocal;
  }

  mean(): number {
    return this.count === 0 ? this.opt.expectedIntervalS : this.sum / this.count;
  }

  std(): number {
    if (this.count === 0) return this.opt.minStdS;
    const m = this.sum / this.count;
    const v = Math.max(0, this.sumSq / this.count - m * m);
    return Math.max(Math.sqrt(v), this.opt.minStdS);
  }

  /**
   * phi at `nowLocal`, measured from `since` (default: the last heartbeat; the detector passes the latest alive
   * evidence, which may be a probe ack). 0 before the first heartbeat.
   */
  phi(nowLocal: number, since: number | null = this.last): number {
    if (since === null) return 0;
    const elapsed = Math.max(0, nowLocal - since);
    return phiOf(elapsed, this.mean() + this.opt.acceptablePauseS, this.std());
  }

  private push(x: number): void {
    const n = this.buf.length;
    if (this.count === n) {
      const old = this.buf[this.head];
      this.sum -= old;
      this.sumSq -= old * old;
    } else {
      this.count++;
    }
    this.buf[this.head] = x;
    this.head = (this.head + 1) % n;
    this.sum += x;
    this.sumSq += x * x;
    // bound floating-point drift of the running sums over long runs
    if (++this.sinceRecompute >= 10 * n) {
      this.sinceRecompute = 0;
      let s = 0;
      let s2 = 0;
      for (let i = 0; i < this.count; i++) {
        const k = (this.head - 1 - i + 2 * n) % n;
        s += this.buf[k];
        s2 += this.buf[k] * this.buf[k];
      }
      this.sum = s;
      this.sumSq = s2;
    }
  }
}

// ---- failure detector -----------------------------------------------------------------------------------

export type DeclareReason = 'distress' | 'quorum' | 'silence';

export interface HealthTransition {
  peer: NodeId;
  from: PeerHealth;
  to: PeerHealth;
  /** Local time of the `update` that observed it. */
  atLocal: number;
  /** phi at that time (Infinity-free; 0 for a peer never heard). */
  phi: number;
  /** Set when `to` is DECLARED_FAILED. */
  reason?: DeclareReason;
  /** DECLARED_FAILED -> ALIVE because the peer was heard again; integration decides what that means. */
  resurrected?: boolean;
}

export interface ProbeRequest {
  target: NodeId;
  /** Helpers to send `PROBE { target }` to, sorted by id (up to `probeFanout`). */
  via: NodeId[];
}

export interface ProbeAnswer {
  target: NodeId;
  /** True when this node heard the target recently enough that it would not suspect it (phi < phiSuspect). */
  alive: boolean;
  /** Local time this node last heard the target (null if never). Not comparable across nodes; informational. */
  lastSeen: number | null;
  /** Seconds since this node last heard the target (null if never). Comparable across nodes. */
  sinceS: number | null;
}

export interface FailureDetectorOptions {
  /** Bootstrap heartbeat interval (s). Default 0.1 (`SIM.heartbeatPeriod`). */
  expectedIntervalS: number;
  /** Akka acceptable-heartbeat-pause added to the mean (s). Default 0: phi 5/9 exactly as PRD section 15. */
  acceptablePauseS: number;
  /** Re-probe a still-suspected peer at most this often (s). Default 1. */
  probeIntervalS: number;
  /** An UNREACHABLE report counts towards the quorum for this long after it was received (s). Default 10. */
  reportTtlS: number;
  /**
   * Endurance bound (s) assumed for a peer that never reported its own (`setEndurance`), counted from when this
   * detector first learned of it. Silence declares a peer only once it cannot still be aloft (03 section 3.6).
   * Default 0: the plain `tFailedS` bound (TC-09 unit behaviour).
   */
  maxEnduranceS: number;
}

export const FAILURE_DETECTOR_DEFAULTS: FailureDetectorOptions = {
  expectedIntervalS: 0.1,
  acceptablePauseS: 0,
  probeIntervalS: 1,
  reportTtlS: 10,
  maxEnduranceS: 0,
};

interface PeerState {
  phi: PhiAccrual;
  /** Health last reported by `update` (the diff base for transitions). */
  reported: PeerHealth;
  /** Latest local time of any alive evidence: own heartbeat or an alive probe ack. */
  aliveEvidence: number | null;
  lastProbe: number | null;
  /** Latched declaration (absorbing until heard again; distress is sticky, see `heartbeat`). */
  declared: DeclareReason | null;
  /** First local time the peer became known to this detector (any channel). */
  firstKnown: number;
  /** Latest indirect alive evidence (e.g. a newer gossiped status of the peer), or null. Not a phi sample. */
  indirect: number | null;
  /** Local time until which the peer may still be aloft on its last reported energy (physical bound), or null. */
  enduranceUntil: number | null;
  /** Observers whose reports made a quorum declaration (sorted), for the event log. */
  declaredBy: NodeId[];
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One node's failure detector. Feed it heartbeats (`heartbeat`), call `update` once per tick for transitions, send
 * the probes `probesToSend` asks for, answer incoming probes with `answerProbe`, feed acks to `onProbeAck`, DISTRESS
 * to `onDistress` and other nodes' UNREACHABLE reports to `reportUnreachable`. `declared` is the DECLARED_FAILED
 * decision (the origin depot is the only node that acts on it; design section 7).
 */
export class FailureDetector {
  readonly params: FailureParams;
  readonly opts: FailureDetectorOptions;
  private readonly peers = new Map<NodeId, PeerState>();
  /** target -> observer -> local time the observer's UNREACHABLE report was (last) received. */
  private readonly reports = new Map<NodeId, Map<NodeId, number>>();

  constructor(
    readonly me: NodeId,
    params: FailureParams = P2P_DEFAULTS.failure,
    opts: Partial<FailureDetectorOptions> = {},
  ) {
    this.params = { ...params };
    this.opts = { ...FAILURE_DETECTOR_DEFAULTS, ...opts };
    if (!(this.params.phiUnreachable >= this.params.phiSuspect)) throw new Error('phiUnreachable < phiSuspect');
    if (!(this.params.quorum >= 1)) throw new Error('quorum must be >= 1');
  }

  // ---- inputs -------------------------------------------------------------------------------------------

  /** A HEARTBEAT (or any direct message) from `peer` arrived at local time `nowLocal`. */
  heartbeat(peer: NodeId, nowLocal: number): void {
    if (peer === this.me) return;
    const s = this.peer(peer, nowLocal);
    s.phi.heartbeat(nowLocal);
    s.aliveEvidence = Math.max(s.aliveEvidence ?? -Infinity, nowLocal);
    // Heard again: a quorum/silence declaration is lifted (the next update logs a resurrection). A DISTRESS
    // declaration is sticky: the peer told us itself it is going down, and may keep beaconing while it does.
    if (s.declared !== null && s.declared !== 'distress') s.declared = null;
  }

  /**
   * Indirect alive evidence at `nowLocal` (integration): something the peer wrote recently reached me through others,
   * e.g. a newer seq of its gossiped status. It does not feed phi (no beacon timing), but it voids quorum reports
   * received before it, restarts the silence clock, and lifts a quorum / silence declaration (not a distress one).
   */
  heardIndirect(peer: NodeId, nowLocal: number): void {
    if (peer === this.me) return;
    const s = this.peer(peer, nowLocal);
    s.indirect = Math.max(s.indirect ?? -Infinity, nowLocal);
    if (s.declared !== null && s.declared !== 'distress') s.declared = null;
  }

  /**
   * Physical evidence (03 section 3.6): the peer's own report, received at `nowLocal`, that it can stay aloft for at
   * most `enduranceS` more seconds (its energy over the minimum power draw). Silence cannot declare it failed before
   * `nowLocal + enduranceS`: until then a silent peer may simply be out of range. The latest report replaces older ones.
   */
  setEndurance(peer: NodeId, enduranceS: number, nowLocal: number): void {
    if (peer === this.me || !Number.isFinite(enduranceS)) return;
    this.peer(peer, nowLocal).enduranceUntil = nowLocal + Math.max(0, enduranceS);
  }

  /** Local time before which silence cannot declare `peer` failed (the endurance bound), or null if unknown. */
  enduranceUntil(peer: NodeId): number | null {
    const s = this.peers.get(peer);
    if (!s) return null;
    return s.enduranceUntil ?? s.firstKnown + this.opts.maxEnduranceS;
  }

  /** Observers whose UNREACHABLE reports made the (latched) quorum declaration of `peer`, sorted; [] otherwise. */
  declaredBy(peer: NodeId): NodeId[] {
    return [...(this.peers.get(peer)?.declaredBy ?? [])];
  }

  /** The peer's own DISTRESS broadcast: DECLARED_FAILED immediately (REQ-FAIL-003). */
  onDistress(peer: NodeId, nowLocal: number): void {
    if (peer === this.me) return;
    this.peer(peer, nowLocal).declared = 'distress';
  }

  /**
   * `observer` reports `target` UNREACHABLE (received at local `nowLocal`). One vote per observer (a repeat refreshes
   * its time); the target cannot vote on itself. Callers include this node's own view by passing `me` as observer.
   */
  reportUnreachable(observer: NodeId, target: NodeId, nowLocal: number): void {
    if (observer === target) return;
    this.peer(target, nowLocal);
    let m = this.reports.get(target);
    if (!m) this.reports.set(target, (m = new Map()));
    m.set(observer, Math.max(m.get(observer) ?? -Infinity, nowLocal));
  }

  /** Withdraw `observer`'s report (it hears the target again). */
  retractUnreachable(observer: NodeId, target: NodeId): void {
    this.reports.get(target)?.delete(observer);
  }

  /**
   * PROBE_ACK from helper `from` about `target`. An alive ack is alive evidence at `nowLocal`: suspicion is measured
   * from it (phi drops back) and quorum reports received before it are void. It does not resurrect a declared peer
   * (that needs the peer itself to be heard). A not-alive ack changes nothing.
   */
  onProbeAck(from: NodeId, target: NodeId, alive: boolean, nowLocal: number): void {
    if (!alive || target === this.me) return;
    const s = this.peers.get(target);
    if (!s || s.declared !== null) return;
    s.aliveEvidence = Math.max(s.aliveEvidence ?? -Infinity, nowLocal);
    void from;
  }

  // ---- queries ------------------------------------------------------------------------------------------

  /** phi for `peer` at `nowLocal`, from its latest alive evidence (0 for a peer never heard). */
  phi(peer: NodeId, nowLocal: number): number {
    const s = this.peers.get(peer);
    return s ? s.phi.phi(nowLocal, s.aliveEvidence) : 0;
  }

  /** Current health in this node's view (computed, not the last reported one). Unknown peers are ALIVE. */
  health(peer: NodeId, nowLocal: number): PeerHealth {
    const s = this.peers.get(peer);
    if (!s) return 'ALIVE';
    if (s.declared !== null) return 'DECLARED_FAILED';
    return this.phiHealth(s, nowLocal);
  }

  /** Every peer this detector knows, sorted. */
  knownPeers(): NodeId[] {
    return [...this.peers.keys()].sort(byId);
  }

  /** Local time `peer` was last heard directly (null if never). */
  lastHeard(peer: NodeId): number | null {
    return this.peers.get(peer)?.phi.lastArrival ?? null;
  }

  /** Distinct observers whose UNREACHABLE report on `target` is still valid at `nowLocal`, sorted. */
  quorumObservers(target: NodeId, nowLocal: number, lastHeardLocal: number | null = null): NodeId[] {
    const m = this.reports.get(target);
    if (!m) return [];
    const s = this.peers.get(target);
    const voidBefore = Math.max(s?.aliveEvidence ?? -Infinity, lastHeardLocal ?? -Infinity, s?.indirect ?? -Infinity);
    const out: NodeId[] = [];
    for (const obs of [...m.keys()].sort(byId)) {
      const t = m.get(obs)!;
      if (t > voidBefore && nowLocal - t <= this.opts.reportTtlS) out.push(obs);
    }
    return out;
  }

  /**
   * DECLARED_FAILED decision for `target` at `nowLocal` (REQ-FAIL-003), latched once true:
   * - `distress`: the target's own DISTRESS was received;
   * - `quorum`: >= `quorum` distinct observers reported it UNREACHABLE within `reportTtlS`, with no alive evidence
   *   (own heartbeat, alive probe ack, or `lastHeardLocal`) since those reports;
   * - `silence`: no evidence of it for `tFailedS`, and past its endurance bound (`setEndurance`, else
   *   `maxEnduranceS` from when it became known): a peer that may still be aloft on battery is not declared on
   *   silence alone. The silence clock starts at the latest of: own last heartbeat / alive ack, `lastHeardLocal`
   *   (e.g. its last status update via gossip), or when this detector first learned of it.
   * Returns the reason, or null.
   */
  declared(target: NodeId, nowLocal: number, lastHeardLocal: number | null = null): DeclareReason | null {
    if (target === this.me) return null;
    const s = this.peers.get(target);
    if (!s) return null;
    if (s.declared !== null) return s.declared;
    if (s.indirect !== null) lastHeardLocal = Math.max(lastHeardLocal ?? -Infinity, s.indirect);
    const obs = this.quorumObservers(target, nowLocal, lastHeardLocal);
    if (obs.length >= this.params.quorum) {
      s.declared = 'quorum';
      s.declaredBy = obs;
    } else {
      const ref = Math.max(s.aliveEvidence ?? -Infinity, lastHeardLocal ?? -Infinity, s.firstKnown);
      const bound = s.enduranceUntil ?? s.firstKnown + this.opts.maxEnduranceS;
      if (nowLocal - ref >= this.params.tFailedS && nowLocal >= bound) s.declared = 'silence';
    }
    return s.declared;
  }

  // ---- tick ---------------------------------------------------------------------------------------------

  /**
   * Re-evaluate every peer at `nowLocal` and return health changes since the previous call, sorted by peer id.
   * Also latches declarations (quorum / silence on own evidence) and drops expired quorum reports.
   */
  update(nowLocal: number): HealthTransition[] {
    this.pruneReports(nowLocal);
    const out: HealthTransition[] = [];
    for (const id of this.knownPeers()) {
      const s = this.peers.get(id)!;
      this.declared(id, nowLocal);
      const to: PeerHealth = s.declared !== null ? 'DECLARED_FAILED' : this.phiHealth(s, nowLocal);
      if (to === s.reported) continue;
      const tr: HealthTransition = { peer: id, from: s.reported, to, atLocal: nowLocal, phi: this.phi(id, nowLocal) };
      if (to === 'DECLARED_FAILED') tr.reason = s.declared!;
      if (s.reported === 'DECLARED_FAILED') tr.resurrected = true;
      s.reported = to;
      out.push(tr);
    }
    return out;
  }

  /**
   * Probes due at `nowLocal`: one per SUSPECT / UNREACHABLE (not declared) peer not probed in the last
   * `probeIntervalS`, through up to `probeFanout` helpers. Helpers are the ALIVE peers (excluding the target) heard
   * most recently, ties by id, returned sorted by id. Calling this marks the probes as sent. Sorted by target.
   */
  probesToSend(nowLocal: number, eligible?: (peer: NodeId) => boolean): ProbeRequest[] {
    const ids = this.knownPeers();
    const alive = ids
      .filter((id) => this.health(id, nowLocal) === 'ALIVE' && this.peers.get(id)!.phi.lastArrival !== null)
      .map((id) => ({ id, t: this.peers.get(id)!.phi.lastArrival! }))
      .sort((a, b) => b.t - a.t || byId(a.id, b.id));
    const out: ProbeRequest[] = [];
    for (const target of ids) {
      const h = this.health(target, nowLocal);
      if (h !== 'SUSPECT' && h !== 'UNREACHABLE') continue;
      if (eligible && !eligible(target)) continue;
      const s = this.peers.get(target)!;
      if (s.lastProbe !== null && nowLocal - s.lastProbe < this.opts.probeIntervalS) continue;
      const via = alive
        .filter((a) => a.id !== target)
        .slice(0, this.params.probeFanout)
        .map((a) => a.id)
        .sort(byId);
      if (via.length === 0) continue;
      s.lastProbe = nowLocal;
      out.push({ target, via });
    }
    return out;
  }

  /** Helper side: answer `PROBE { target }` from this node's own direct evidence. */
  answerProbe(target: NodeId, nowLocal: number): ProbeAnswer {
    const s = this.peers.get(target);
    const last = s?.phi.lastArrival ?? null;
    if (!s || last === null) return { target, alive: false, lastSeen: null, sinceS: null };
    // direct evidence only: phi from the last heartbeat, not from acks (no hearsay chains)
    const alive = s.declared === null && s.phi.phi(nowLocal, last) < this.params.phiSuspect;
    return { target, alive, lastSeen: last, sinceS: nowLocal - last };
  }

  /** Forget a peer entirely (e.g. it left the fleet). */
  forget(peer: NodeId): void {
    this.peers.delete(peer);
    this.reports.delete(peer);
    for (const m of this.reports.values()) m.delete(peer);
  }

  // ---- internals ----------------------------------------------------------------------------------------

  private peer(id: NodeId, nowLocal: number): PeerState {
    let s = this.peers.get(id);
    if (!s) {
      s = {
        phi: new PhiAccrual({
          windowSize: this.params.windowSize,
          minStdS: this.params.minStdS,
          expectedIntervalS: this.opts.expectedIntervalS,
          acceptablePauseS: this.opts.acceptablePauseS,
        }),
        reported: 'ALIVE',
        aliveEvidence: null,
        lastProbe: null,
        declared: null,
        firstKnown: nowLocal,
        indirect: null,
        enduranceUntil: null,
        declaredBy: [],
      };
      this.peers.set(id, s);
    }
    return s;
  }

  private phiHealth(s: PeerState, nowLocal: number): PeerHealth {
    // a peer known only from reports (never heard directly) has no phi: ALIVE in our own view
    if (s.aliveEvidence === null) return 'ALIVE';
    const p = s.phi.phi(nowLocal, s.aliveEvidence);
    if (p >= this.params.phiUnreachable) return 'UNREACHABLE';
    if (p >= this.params.phiSuspect) return 'SUSPECT';
    return 'ALIVE';
  }

  private pruneReports(nowLocal: number): void {
    for (const target of [...this.reports.keys()].sort(byId)) {
      const m = this.reports.get(target)!;
      for (const obs of [...m.keys()].sort(byId)) if (nowLocal - m.get(obs)! > this.opts.reportTtlS) m.delete(obs);
      if (m.size === 0) this.reports.delete(target);
    }
  }
}
