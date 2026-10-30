import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import { P2P_DEFAULTS } from './contracts';
import { FailureDetector, PhiAccrual, phiOf, type HealthTransition } from './failure';

const P = P2P_DEFAULTS.failure;
const HB = 0.1; // SIM.heartbeatPeriod
const STEP = 0.05; // detector tick in these tests

/** Feed `peer` heartbeats every HB from t0 to t1 (exclusive) and tick at STEP. Returns the transitions. */
function beat(fd: FailureDetector, peers: string[], t0: number, t1: number): HealthTransition[] {
  const out: HealthTransition[] = [];
  const n = Math.round((t1 - t0) / STEP);
  for (let i = 0; i < n; i++) {
    const t = t0 + i * STEP;
    if (i % 2 === 0) for (const p of peers) fd.heartbeat(p, t);
    out.push(...fd.update(t));
  }
  return out;
}

/** First local time at or after t0 (STEP grid) at which `peer` reaches health `h`. */
function firstAt(fd: FailureDetector, peer: string, t0: number, h: string, tMax = t0 + 100): number {
  for (let t = t0; t <= tMax; t += 0.001) if (fd.health(peer, t) === h) return t;
  return Infinity;
}

describe('phiOf', () => {
  it('is finite, non-negative and strictly increasing in elapsed time', () => {
    let prev = -1;
    for (let e = 0; e <= 50; e += 0.01) {
      const p = phiOf(e, 0.1, 0.1);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
    expect(phiOf(0.1, 0.1, 0.1)).toBeCloseTo(Math.log10(2), 6); // at the mean, P(later) = 1/2
  });
});

describe('PhiAccrual', () => {
  it('bootstraps from the first heartbeat and floors the std', () => {
    const a = new PhiAccrual({ windowSize: 100, minStdS: 0.1, expectedIntervalS: 0.1, acceptablePauseS: 0 });
    expect(a.phi(5)).toBe(0); // never heard
    a.heartbeat(0);
    expect(a.samples).toBe(2);
    expect(a.mean()).toBeCloseTo(0.1, 9);
    expect(a.std()).toBe(0.1);
    for (let i = 1; i <= 300; i++) a.heartbeat(i * 0.1);
    expect(a.samples).toBe(100);
    expect(a.mean()).toBeCloseTo(0.1, 9);
    expect(a.std()).toBe(0.1); // perfectly regular -> floored
    a.heartbeat(30); // duplicate / out of order: ignored as a sample
    expect(a.lastArrival).toBeCloseTo(30, 9);
  });

  it('phi rises monotonically with silence', () => {
    const a = new PhiAccrual({ windowSize: 100, minStdS: 0.1, expectedIntervalS: 0.1, acceptablePauseS: 0 });
    for (let i = 0; i <= 200; i++) a.heartbeat(i * 0.1);
    let prev = -1;
    for (let t = 20; t < 30; t += 0.01) {
      const p = a.phi(t);
      expect(p).toBeGreaterThan(prev);
      prev = p;
    }
  });
});

describe('FailureDetector: detection latency at 10 Hz', () => {
  it('SUSPECT then UNREACHABLE shortly after the heartbeats stop, ALIVE again when heard', () => {
    const fd = new FailureDetector('A');
    const trs = beat(fd, ['B'], 0, 20);
    expect(trs).toEqual([]); // steady 10 Hz: never suspected
    const last = fd.lastHeard('B')!;
    const tS = firstAt(fd, 'B', last, 'SUSPECT');
    const tU = firstAt(fd, 'B', last, 'UNREACHABLE');
    const latS = tS - last;
    const latU = tU - last;
    console.log(`[TC-09] detection latency after last heartbeat (10 Hz, 0% loss): SUSPECT ${latS.toFixed(3)} s, UNREACHABLE ${latU.toFixed(3)} s`);
    expect(latS).toBeGreaterThan(0.3);
    expect(latS).toBeLessThan(1);
    expect(latU).toBeGreaterThan(latS);
    expect(latU).toBeLessThan(1.5);
    // transitions through update are in order and carry phi
    const t1 = fd.update(last + latS + 0.001);
    expect(t1.map((t) => [t.peer, t.from, t.to])).toEqual([['B', 'ALIVE', 'SUSPECT']]);
    const t2 = fd.update(last + latU + 0.001);
    expect(t2.map((t) => [t.from, t.to])).toEqual([['SUSPECT', 'UNREACHABLE']]);
    expect(t2[0].phi).toBeGreaterThanOrEqual(P.phiUnreachable);
    fd.heartbeat('B', last + 2);
    expect(fd.update(last + 2).map((t) => [t.from, t.to])).toEqual([['UNREACHABLE', 'ALIVE']]);
  });

  it('transitions are reported in sorted peer order', () => {
    const fd = new FailureDetector('A');
    beat(fd, ['D', 'C', 'B'], 0, 5);
    const trs = fd.update(10);
    expect(trs.map((t) => t.peer)).toEqual(['B', 'C', 'D']);
    expect(trs.every((t) => t.to === 'UNREACHABLE')).toBe(true);
  });
});

/**
 * Long run of one live peer at 10 Hz with send jitter (+-10 ms) and delivery-latency jitter (5..25 ms), independent
 * Bernoulli loss. Every SUSPECT / UNREACHABLE is false (the peer never fails). Rates per peer-hour.
 */
function falseSuspicion(loss: number, hours: number, seed: number, acceptablePauseS = 0) {
  const rng = new Rng(seed);
  const fd = new FailureDetector('A', P, { acceptablePauseS });
  const tEnd = hours * 3600;
  const arrivals: number[] = [];
  for (let k = 0; k * HB < tEnd; k++) {
    if (rng.chance(loss)) continue;
    arrivals.push(k * HB + rng.range(-0.01, 0.01) + rng.range(0.005, 0.025));
  }
  arrivals.sort((a, b) => a - b);
  let i = 0;
  let suspect = 0;
  let unreachable = 0;
  let suspectTime = 0;
  let prevT = 0;
  let prevH = 'ALIVE';
  for (let t = 0; t < tEnd; t += STEP) {
    while (i < arrivals.length && arrivals[i] <= t) fd.heartbeat('B', arrivals[i++]);
    for (const tr of fd.update(t)) {
      if (tr.from === 'ALIVE' && tr.to !== 'ALIVE') suspect++;
      if (tr.to === 'UNREACHABLE') unreachable++;
    }
    if (prevH !== 'ALIVE') suspectTime += t - prevT;
    prevH = fd.health('B', t);
    prevT = t;
  }
  return { suspectPerHour: suspect / hours, unreachablePerHour: unreachable / hours, suspectFrac: suspectTime / tEnd };
}

describe('FailureDetector: false-suspicion rate (TC-09 done-when)', () => {
  // Analytical expectation with phi 5 / 9, std floor 0.1 s: SUSPECT ~0.5 s and UNREACHABLE ~0.65 s after the last
  // beacon, i.e. after ~5 / ~6-7 consecutive lost 10 Hz beacons. Rates scale like loss^k per received beacon.
  const HOURS = 2;
  const cases: Array<[number, number, number]> = [
    // loss, max false SUSPECT /peer-h, max false UNREACHABLE /peer-h (bounds ~3x the measured values)
    [0.0, 0, 0],
    [0.2, 40, 2],
    [0.4, 400, 120],
  ];
  for (const [loss, maxS, maxU] of cases) {
    it(`loss ${loss * 100}%: bounded false SUSPECT / UNREACHABLE per peer-hour`, () => {
      const r = falseSuspicion(loss, HOURS, 9000 + loss * 100);
      console.log(
        `[TC-09] loss ${(loss * 100).toFixed(0)}%: false SUSPECT ${r.suspectPerHour.toFixed(1)}/peer-h, ` +
          `false UNREACHABLE ${r.unreachablePerHour.toFixed(1)}/peer-h, time suspected ${(r.suspectFrac * 100).toFixed(3)}%`,
      );
      expect(r.suspectPerHour).toBeLessThanOrEqual(maxS);
      expect(r.unreachablePerHour).toBeLessThanOrEqual(maxU);
    });
  }

  it('an acceptable pause of 0.5 s cuts false suspicion at 40% loss by orders of magnitude', () => {
    const r = falseSuspicion(0.4, HOURS, 9040, 0.5);
    console.log(
      `[TC-09] loss 40%, acceptablePause 0.5 s: false SUSPECT ${r.suspectPerHour.toFixed(1)}/peer-h, ` +
        `false UNREACHABLE ${r.unreachablePerHour.toFixed(1)}/peer-h`,
    );
    expect(r.suspectPerHour).toBeLessThanOrEqual(20);
    expect(r.unreachablePerHour).toBeLessThanOrEqual(5);
  });
});

describe('FailureDetector: indirect probing', () => {
  it('asks up to probeFanout most recently heard ALIVE helpers, sorted by id, rate-limited', () => {
    const fd = new FailureDetector('A');
    beat(fd, ['B', 'C', 'D', 'E', 'T'], 0, 5);
    // B, C, D keep beaconing; E is heard least recently (stops at 5.6, still ALIVE at 6); T goes silent
    const t = 6;
    for (let k = 1; k <= 10; k++) {
      const tk = 5 + k * HB;
      for (const p of ['B', 'C', 'D']) fd.heartbeat(p, tk);
      if (tk <= 5.6 + 1e-9) fd.heartbeat('E', tk);
    }
    fd.update(t);
    expect(fd.health('E', t)).toBe('ALIVE');
    expect(fd.health('T', t)).toBe('UNREACHABLE');
    const probes = fd.probesToSend(t);
    expect(probes).toEqual([{ target: 'T', via: ['B', 'C', 'D'] }]);
    expect(fd.probesToSend(t + 0.5).filter((p) => p.target === 'T')).toEqual([]); // rate-limited
    for (let k = 1; k <= 10; k++) fd.heartbeat('B', t + k * HB);
    expect(fd.probesToSend(t + 1).filter((p) => p.target === 'T')).toEqual([{ target: 'T', via: ['B'] }]);
    expect(fd.probesToSend(t + 1.01)).toEqual([]);
    // no ALIVE helper at all: nothing to send
    expect(fd.probesToSend(t + 10)).toEqual([]);
  });

  it('a suspect a helper still hears is cleared; one nobody hears is not', () => {
    const a = new FailureDetector('A');
    const helper = new FailureDetector('H');
    beat(a, ['H', 'T', 'U'], 0, 10);
    beat(helper, ['T', 'U'], 0, 10);
    // A loses T and U (e.g. range); H still hears T, nobody hears U
    let t = 10;
    for (; t < 11.5; t += HB) {
      a.heartbeat('H', t);
      helper.heartbeat('T', t);
      a.update(t);
      helper.update(t);
    }
    expect(a.health('T', t)).not.toBe('ALIVE');
    expect(a.health('U', t)).not.toBe('ALIVE');
    const probes = a.probesToSend(t);
    expect(probes).toEqual([
      { target: 'T', via: ['H'] },
      { target: 'U', via: ['H'] },
    ]);
    for (const p of probes) {
      const ans = helper.answerProbe(p.target, t);
      a.onProbeAck('H', p.target, ans.alive, t);
    }
    expect(helper.answerProbe('T', t).alive).toBe(true);
    expect(helper.answerProbe('U', t)).toMatchObject({ alive: false });
    expect(helper.answerProbe('nobody', t)).toEqual({ target: 'nobody', alive: false, lastSeen: null, sinceS: null });
    const trs = a.update(t);
    expect(trs.map((x) => [x.peer, x.to])).toEqual([['T', 'ALIVE']]);
    expect(a.health('U', t)).toBe('UNREACHABLE');
  });

  it('an alive ack voids earlier quorum reports', () => {
    const fd = new FailureDetector('D');
    beat(fd, ['T'], 0, 2);
    fd.reportUnreachable('X', 'T', 5);
    fd.reportUnreachable('Y', 'T', 5.5);
    fd.onProbeAck('H', 'T', true, 6);
    expect(fd.declared('T', 6)).toBeNull();
  });
});

describe('FailureDetector: failure quorum', () => {
  function silentPeer(): FailureDetector {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T', 'X', 'Y'], 0, 2); // T last heard at ~1.9
    return fd;
  }

  it('one observer is not enough; two independent observers are', () => {
    const fd = silentPeer();
    fd.reportUnreachable('X', 'T', 5);
    expect(fd.declared('T', 5)).toBeNull();
    fd.reportUnreachable('X', 'T', 6); // same observer again counts once
    expect(fd.quorumObservers('T', 6)).toEqual(['X']);
    expect(fd.declared('T', 6)).toBeNull();
    fd.reportUnreachable('T', 'T', 6); // the target cannot vote on itself
    expect(fd.declared('T', 6)).toBeNull();
    fd.reportUnreachable('Y', 'T', 7);
    expect(fd.quorumObservers('T', 7)).toEqual(['X', 'Y']);
    expect(fd.declared('T', 7)).toBe('quorum');
    const trs = fd.update(7).filter((t) => t.peer === 'T');
    expect(trs).toHaveLength(1);
    expect(trs[0]).toMatchObject({ to: 'DECLARED_FAILED', reason: 'quorum' });
  });

  it('this node counts as an observer when it reports itself', () => {
    const fd = silentPeer();
    fd.reportUnreachable('DEPOT', 'T', 5);
    fd.reportUnreachable('X', 'T', 5);
    expect(fd.declared('T', 5)).toBe('quorum');
  });

  it('stale reports expire', () => {
    const fd = silentPeer();
    fd.reportUnreachable('X', 'T', 5);
    fd.reportUnreachable('Y', 'T', 16); // X's report is 11 s old > reportTtlS 10
    expect(fd.quorumObservers('T', 16)).toEqual(['Y']);
    expect(fd.declared('T', 16)).toBeNull();
    fd.update(16);
    fd.reportUnreachable('X', 'T', 17);
    expect(fd.declared('T', 17)).toBe('quorum');
  });

  it('reports older than any alive evidence do not count', () => {
    const fd = silentPeer();
    fd.reportUnreachable('X', 'T', 5);
    fd.reportUnreachable('Y', 'T', 5);
    expect(fd.declared('T', 5, 5.5)).toBeNull(); // caller heard of it (gossiped status) after the reports
    const fd2 = silentPeer();
    fd2.reportUnreachable('X', 'T', 5);
    fd2.heartbeat('T', 5.2);
    fd2.reportUnreachable('Y', 'T', 5.5);
    expect(fd2.declared('T', 5.5)).toBeNull();
    fd2.retractUnreachable('Y', 'T');
    expect(fd2.quorumObservers('T', 5.5)).toEqual([]);
  });
});

describe('FailureDetector: tFailed bound, distress, resurrection', () => {
  it('declares after tFailedS of silence, not before', () => {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T'], 0, 2);
    const last = fd.lastHeard('T')!;
    expect(fd.declared('T', last + P.tFailedS - 0.01)).toBeNull();
    expect(fd.update(last + P.tFailedS - 0.01).some((t) => t.to === 'DECLARED_FAILED')).toBe(false);
    const trs = fd.update(last + P.tFailedS);
    expect(trs).toEqual([
      expect.objectContaining({ peer: 'T', from: 'UNREACHABLE', to: 'DECLARED_FAILED', reason: 'silence' }),
    ]);
    // absorbing: further updates are quiet, and a later lastHeardLocal does not undo it
    expect(fd.update(last + 100)).toEqual([]);
    expect(fd.declared('T', last + 100, last + 99)).toBe('silence');
  });

  it('lastHeardLocal (e.g. gossiped status) postpones the silence bound', () => {
    const fd = new FailureDetector('DEPOT');
    fd.heartbeat('T', 0);
    expect(fd.declared('T', 61, 30)).toBeNull();
    expect(fd.declared('T', 90, 30)).toBe('silence');
  });

  it('a peer known only from reports times out from when it became known', () => {
    const fd = new FailureDetector('DEPOT');
    fd.reportUnreachable('X', 'T', 10);
    expect(fd.health('T', 11)).toBe('ALIVE');
    expect(fd.declared('T', 69)).toBeNull();
    expect(fd.declared('T', 70)).toBe('silence');
  });

  it('distress declares immediately and stays declared even if the peer keeps beaconing', () => {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T'], 0, 2);
    fd.onDistress('T', 2);
    expect(fd.update(2)).toEqual([expect.objectContaining({ peer: 'T', to: 'DECLARED_FAILED', reason: 'distress' })]);
    fd.heartbeat('T', 2.1);
    expect(fd.update(2.1)).toEqual([]);
    expect(fd.health('T', 2.1)).toBe('DECLARED_FAILED');
    expect(fd.probesToSend(3)).toEqual([]);
  });

  it('a quorum/silence-declared peer heard again is resurrected (logged)', () => {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T'], 0, 2);
    fd.update(70);
    expect(fd.health('T', 70)).toBe('DECLARED_FAILED');
    fd.onProbeAck('H', 'T', true, 71); // hearsay does not resurrect
    expect(fd.health('T', 71)).toBe('DECLARED_FAILED');
    fd.heartbeat('T', 72);
    expect(fd.update(72)).toEqual([
      expect.objectContaining({ peer: 'T', from: 'DECLARED_FAILED', to: 'ALIVE', resurrected: true }),
    ]);
  });

  it('ignores self', () => {
    const fd = new FailureDetector('A');
    fd.heartbeat('A', 1);
    fd.onDistress('A', 1);
    expect(fd.knownPeers()).toEqual([]);
    expect(fd.declared('A', 100)).toBeNull();
  });
});

describe('FailureDetector: determinism', () => {
  function run(seed: number): string {
    const rng = new Rng(seed);
    const fd = new FailureDetector('A');
    const peers = ['P3', 'P1', 'P2', 'P0'];
    const log: string[] = [];
    for (let k = 0; k < 2000; k++) {
      const t = k * STEP;
      for (const p of peers) if ((p !== 'P0' || k < 1000) && rng.chance(0.6)) fd.heartbeat(p, t + rng.range(0, 0.02));
      if (rng.chance(0.01)) fd.reportUnreachable(rng.pick(peers), rng.pick(peers), t);
      for (const tr of fd.update(t)) log.push(`${tr.atLocal.toFixed(3)} ${tr.peer} ${tr.from}>${tr.to} ${tr.phi.toFixed(6)}`);
      for (const p of fd.probesToSend(t)) log.push(`probe ${p.target} via ${p.via.join(',')}`);
    }
    return log.join('\n');
  }
  it('same seed, same transitions and probes', () => {
    const a = run(42);
    expect(a.length).toBeGreaterThan(0);
    expect(run(42)).toBe(a);
  });
});

describe('FailureDetector: endurance bound (physical evidence, 03 section 3.6)', () => {
  it('silence cannot declare a peer before the endurance it reported has run out', () => {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T'], 0, 2);
    const last = fd.lastHeard('T')!;
    fd.setEndurance('T', 300, last); // its last status: 300 s of flight left
    expect(fd.enduranceUntil('T')).toBeCloseTo(last + 300, 9);
    expect(fd.declared('T', last + P.tFailedS + 1)).toBeNull();
    expect(fd.declared('T', last + 299)).toBeNull();
    expect(fd.declared('T', last + 300)).toBe('silence');
  });

  it('a short endurance never shortens the tFailedS bound', () => {
    const fd = new FailureDetector('DEPOT');
    beat(fd, ['T'], 0, 2);
    const last = fd.lastHeard('T')!;
    fd.setEndurance('T', 5, last);
    expect(fd.declared('T', last + P.tFailedS - 0.01)).toBeNull();
    expect(fd.declared('T', last + P.tFailedS)).toBe('silence');
  });

  it('a peer that never reported its endurance gets maxEnduranceS from when it became known; the latest report replaces it', () => {
    const fd = new FailureDetector('DEPOT', P, { maxEnduranceS: 1000 });
    fd.heartbeat('T', 10);
    expect(fd.enduranceUntil('T')).toBe(1010);
    expect(fd.declared('T', 500)).toBeNull();
    fd.setEndurance('T', 100, 20);
    expect(fd.enduranceUntil('T')).toBe(120);
    expect(fd.declared('T', 119)).toBeNull();
    expect(fd.declared('T', 120)).toBe('silence');
  });

  it('a quorum is not bound by endurance, and names its observers', () => {
    const fd = new FailureDetector('DEPOT', P, { maxEnduranceS: 1000 });
    fd.heartbeat('T', 0);
    fd.setEndurance('T', 900, 0);
    fd.reportUnreachable('B', 'T', 3);
    fd.reportUnreachable('A', 'T', 3);
    expect(fd.declared('T', 4)).toBe('quorum');
    expect(fd.declaredBy('T')).toEqual(['A', 'B']);
  });
});
