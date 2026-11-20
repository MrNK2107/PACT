import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import { P2P_DEFAULTS, type RadioMapEntry, type RadioMapParams } from './contracts';
import { cellKey, isRadioMapEntry, joinRadioState, plannedLeaseS, predictedDarkS, RadioMap, radioPiggyback, type DarkLookup, type RadioMapState, type XZ } from './radiomap';

/**
 * Decision 22, radio-shadow-aware ownership: the learned radio map (state-based CRDT), the dark-stretch forecast and
 * the planned lease. Unit tests plus seeded property tests (CRDT laws, gossip convergence under loss / duplication /
 * reordering, forecast bounds and monotonicity, lease bounds).
 */

const P: RadioMapParams = { ...P2P_DEFAULTS.radioMap };
const NODES = ['A01', 'A02', 'A03', 'D1'];

function randomState(rng: Rng, n: number): Map<string, [number, number]> {
  const s = new Map<string, [number, number]>();
  for (let i = 0; i < n; i++) {
    const samples = rng.int(0, 30);
    s.set(`${rng.int(-3, 3)},${rng.int(-3, 3)}|${rng.pick(NODES)}`, [samples, rng.int(0, samples)]);
  }
  return s;
}

const canon = (s: RadioMapState) => JSON.stringify([...s.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** A lookup over a set of dark cell keys. */
function darkSet(cells: Iterable<string>, cellM = 100): DarkLookup {
  const set = new Set(cells);
  return { cellM, isDark: (x, z) => set.has(cellKey(x, z, cellM)) };
}

function randomPath(rng: Rng): XZ[] {
  const n = rng.int(2, 6);
  return Array.from({ length: n }, () => ({ x: rng.range(-600, 600), z: rng.range(-600, 600) }));
}

const pathLen = (p: readonly XZ[]) => p.slice(1).reduce((a, q, i) => a + Math.hypot(q.x - p[i].x, q.z - p[i].z), 0);

describe('radio map: cells and wire entries', () => {
  it('cell keys floor both axes, negative coordinates included', () => {
    expect(cellKey(0, 0, 100)).toBe('0,0');
    expect(cellKey(99.9, 100, 100)).toBe('0,1');
    expect(cellKey(-0.1, -100, 100)).toBe('-1,-1');
    expect(cellKey(-100.1, 250, 50)).toBe('-3,5');
  });

  it('accepts only well-formed entries (cell key, origin, integer counters, 0 <= dark <= samples)', () => {
    expect(isRadioMapEntry(['1,-2', 'A01', 5, 3])).toBe(true);
    expect(isRadioMapEntry(['1,-2', 'A01', 5, 6])).toBe(false);
    expect(isRadioMapEntry(['1,-2', 'A01', 5.5, 3])).toBe(false);
    expect(isRadioMapEntry(['1,-2', 'A01', -1, 0])).toBe(false);
    expect(isRadioMapEntry(['x', 'A01', 5, 3])).toBe(false);
    expect(isRadioMapEntry(['1,2', '', 5, 3])).toBe(false);
    expect(isRadioMapEntry(['1,2', 'A|1', 5, 3])).toBe(false);
    expect(isRadioMapEntry({ cell: '1,2' })).toBe(false);
    expect(isRadioMapEntry(['1,2', 'A01', 5, 3, 'extra'])).toBe(true); // unknown trailing fields ignored (NFR-3)
  });

  it('observe counts own samples per cell; statistics sum over origins; few samples = unknown', () => {
    const m = new RadioMap('A01', { ...P, poolNeighbours: false });
    for (let i = 0; i < 3; i++) m.observe(150, 50, true);
    expect(m.cellStats('1,0')).toEqual({ samples: 3, dark: 3 });
    expect(m.darkFraction(150, 50)).toBeNull(); // 3 < minSamples
    m.observe(110, 10, false);
    expect(m.darkFraction(150, 50)).toBeCloseTo(0.75);
    expect(m.isDark(150, 50)).toBe(true);
    m.merge([['1,0', 'A02', 6, 0]]);
    expect(m.cellStats('1,0')).toEqual({ samples: 10, dark: 3 });
    expect(m.isDark(150, 50)).toBe(false);
    expect(m.counters.observations).toBe(4);
  });

  it('a cell with too few samples takes its 3 x 3 neighbourhood when pooling is on', () => {
    const m = new RadioMap('A01', P);
    m.merge([['0,0', 'A02', 10, 9], ['1,1', 'A03', 10, 8]]);
    expect(m.darkFraction(150, 50)).toBeCloseTo(17 / 20); // cell 1,0 has no sample of its own
    expect(m.isDark(150, 50)).toBe(true);
    expect(m.darkFraction(450, 450)).toBeNull(); // nothing within one cell
    const off = new RadioMap('A01', { ...P, poolNeighbours: false });
    off.merge([['0,0', 'A02', 10, 9]]);
    expect(off.darkFraction(150, 50)).toBeNull();
  });

  it('merge ignores malformed entries and keys past the memory bound', () => {
    const m = new RadioMap('A01', { ...P, maxEntries: 2 });
    expect(m.merge('nonsense')).toBe(0);
    expect(m.merge([['0,0', 'A02', 3, 1], ['bad'], ['0,1', 'A02', 2, 9], ['0,2', 'A02', 1, 0], ['0,3', 'A02', 1, 0]])).toBe(2);
    expect(m.size).toBe(2);
    expect(m.counters.entriesIgnored).toBe(3);
    m.observe(0, 900, true); // a third key: past the bound, ignored
    expect(m.size).toBe(2);
    expect(m.merge([['0,0', 'A02', 4, 1]])).toBe(1); // existing keys still grow
  });
});

describe('radio map: state-based CRDT laws (property, seeded)', () => {
  it('join is commutative, associative and idempotent', () => {
    const rng = new Rng(0x2301);
    for (let i = 0; i < 300; i++) {
      const a = randomState(rng, rng.int(0, 12));
      const b = randomState(rng, rng.int(0, 12));
      const c = randomState(rng, rng.int(0, 12));
      expect(canon(joinRadioState(a, b))).toBe(canon(joinRadioState(b, a)));
      expect(canon(joinRadioState(joinRadioState(a, b), c))).toBe(canon(joinRadioState(a, joinRadioState(b, c))));
      expect(canon(joinRadioState(a, a))).toBe(canon(a));
    }
  });

  it('a RadioMap fed any order, duplication and subset of updates converges to the join of everything it received', () => {
    const rng = new Rng(0x2302);
    for (let trial = 0; trial < 60; trial++) {
      // three writers, each observing its own monotone counters
      const writers = ['A01', 'A02', 'A03'].map((id) => new RadioMap(id, P));
      const log: RadioMapEntry[] = [];
      for (let k = 0; k < 120; k++) {
        const w = rng.pick(writers);
        w.observe(rng.range(-250, 250), rng.range(-250, 250), rng.chance(0.4));
        for (const e of w.state()) {
          const bar = e[0].lastIndexOf('|');
          log.push([e[0].slice(0, bar), e[0].slice(bar + 1), e[1][0], e[1][1]]);
        }
      }
      const truth = writers.reduce<Map<string, [number, number]>>((acc, w) => joinRadioState(acc, w.state()), new Map());
      // two replicas get the full log in different shuffled orders with duplicates; a third one a lossy subset
      const r1 = new RadioMap('X1', P);
      const r2 = new RadioMap('X2', P);
      const r3 = new RadioMap('X3', P);
      const shuffled = (xs: RadioMapEntry[]) => {
        const out = [...xs, ...xs.filter(() => rng.chance(0.3))];
        for (let i = out.length - 1; i > 0; i--) {
          const j = rng.int(0, i);
          [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
      };
      for (const e of shuffled(log)) r1.merge([e]);
      r2.merge(shuffled(log));
      const kept = log.filter(() => rng.chance(0.5));
      r3.merge(kept);
      expect(canon(r1.state())).toBe(canon(truth));
      expect(canon(r2.state())).toBe(canon(truth));
      // the lossy replica holds exactly the join of what it got, and catches up once the rest arrives
      const partial = kept.reduce<Map<string, [number, number]>>((acc, [c, o, n, d]) => joinRadioState(acc, new Map([[`${c}|${o}`, [n, d]]])), new Map());
      expect(canon(r3.state())).toBe(canon(partial));
      r3.merge(log);
      expect(canon(r3.state())).toBe(canon(truth));
    }
  });

  it('gossip of take() entries (lossy broadcast, 4 nodes) converges every replica to the same map', () => {
    const rng = new Rng(0x2303);
    const nodes = ['A01', 'A02', 'A03', 'D1'].map((id) => new RadioMap(id, P));
    const pig = nodes.map((m) => radioPiggyback(m));
    for (let t = 0; t < 400; t++) {
      for (const m of nodes.slice(0, 3)) if (t < 200) m.observe(rng.range(-400, 400), rng.range(-400, 400), rng.chance(0.5));
      for (let i = 0; i < nodes.length; i++) {
        const extra = pig[i].take(t);
        if (!extra) continue;
        for (let j = 0; j < nodes.length; j++) if (j !== i && !rng.chance(0.3)) pig[j].accept(extra, nodes[i].self);
      }
    }
    const want = canon(nodes[0].state());
    expect(nodes[0].size).toBeGreaterThan(30);
    for (const m of nodes) expect(canon(m.state())).toBe(want);
  });

  it('take() is bounded and deterministic: changed entries first, then a rotating sweep', () => {
    const p = { ...P, gossipMaxEntries: 5, gossipSweepEntries: 2 };
    const mk = () => {
      const m = new RadioMap('A01', p);
      m.merge(Array.from({ length: 10 }, (_, i): RadioMapEntry => [`${i},0`, 'A02', 5, 1]));
      return m;
    };
    const a = mk();
    const b = mk();
    for (let k = 0; k < 6; k++) {
      const ta = a.take();
      expect(ta).toEqual(b.take());
      expect(ta!.length).toBeLessThanOrEqual(5);
    }
    // all changes drained: only the sweep goes out, 2 entries per push, cycling through everything
    const seen = new Set<string>();
    for (let k = 0; k < 5; k++) for (const e of a.take()!) seen.add(e[0]);
    expect(seen.size).toBe(10);
    a.observe(0, 0, true);
    expect(a.take()![0]).toEqual(['0,0', 'A01', 1, 1]); // a fresh change goes out first
  });
});

describe('dark-stretch forecast (predictedDarkS)', () => {
  it('straight line through a dark band: band length / speed', () => {
    const map = darkSet(['2,0', '3,0', '4,0']);
    expect(predictedDarkS([{ x: 0, z: 50 }, { x: 800, z: 50 }], 10, map)).toBeCloseTo(30, 6);
    expect(predictedDarkS([{ x: 0, z: 50 }, { x: 800, z: 50 }], 15, map)).toBeCloseTo(20, 6);
    expect(predictedDarkS([{ x: 0, z: 50 }], 15, map)).toBe(0);
    expect(predictedDarkS([{ x: 0, z: 50 }, { x: 800, z: 50 }], 0, map)).toBe(0);
  });

  it('the longest stretch wins; a run carries across waypoints; a short lit gap is bridged when asked', () => {
    const map = darkSet(['1,0', '3,0', '4,0', '5,0']);
    const path = [{ x: 0, z: 50 }, { x: 350, z: 50 }, { x: 700, z: 50 }];
    expect(predictedDarkS(path, 10, map)).toBeCloseTo(30, 6); // cells 3..5 (the run carries over the 350 m waypoint)
    expect(predictedDarkS(path, 10, map, 100)).toBeCloseTo(50, 6); // 1 + gap(2) + 3..5
    expect(predictedDarkS(path, 10, map, 99)).toBeCloseTo(30, 6);
  });

  it('a learned map: cells sampled dark ahead give a forecast, a lit map none', () => {
    const m = new RadioMap('A01', P);
    for (let x = 200; x < 500; x += 10) for (let k = 0; k < 2; k++) m.observe(x, 50, true);
    const f = m.predictedDarkS([{ x: 0, z: 50 }, { x: 900, z: 50 }], 15);
    expect(f).toBeGreaterThanOrEqual(300 / 15 - 1e-9);
    expect(f).toBeLessThanOrEqual(500 / 15); // pooling may widen it by at most one cell each side
    const lit = new RadioMap('A01', P);
    for (let x = 0; x < 900; x += 10) lit.observe(x, 50, false);
    expect(lit.predictedDarkS([{ x: 0, z: 50 }, { x: 900, z: 50 }], 15)).toBe(0);
  });

  it('property: 0 <= forecast <= length / speed; monotone in the dark set and in bridging; suffixes never longer', () => {
    const rng = new Rng(0x2304);
    for (let i = 0; i < 400; i++) {
      const cells = new Set<string>();
      for (let k = rng.int(0, 40); k > 0; k--) cells.add(`${rng.int(-6, 5)},${rng.int(-6, 5)}`);
      const more = new Set(cells);
      for (let k = rng.int(1, 10); k > 0; k--) more.add(`${rng.int(-6, 5)},${rng.int(-6, 5)}`);
      const path = randomPath(rng);
      const speed = rng.range(5, 20);
      const bridge = rng.pick([0, 50, 100, 200]);
      const f = predictedDarkS(path, speed, darkSet(cells), bridge);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(pathLen(path) / speed + 1e-9);
      expect(predictedDarkS(path, speed, darkSet(more), bridge)).toBeGreaterThanOrEqual(f - 1e-9);
      expect(predictedDarkS(path, speed, darkSet(cells), bridge + 50)).toBeGreaterThanOrEqual(f - 1e-9);
      expect(predictedDarkS(path.slice(1), speed, darkSet(cells), bridge)).toBeLessThanOrEqual(f + 1e-9);
      expect(predictedDarkS(path, speed * 2, darkSet(cells), bridge)).toBeCloseTo(f / 2, 9);
    }
  });
});

describe('planned lease (plannedLeaseS)', () => {
  it('base without a forecast; covers dark + renew period + margin; capped', () => {
    expect(plannedLeaseS(20, 90, 0, 5, 5)).toBe(20);
    expect(plannedLeaseS(20, 90, 5, 5, 5)).toBe(20);
    expect(plannedLeaseS(20, 90, 30, 5, 5)).toBe(40);
    expect(plannedLeaseS(20, 90, 200, 5, 5)).toBe(90);
    expect(plannedLeaseS(20, 10, 200, 5, 5)).toBe(20); // a cap below base never lowers the lease
  });

  it('property: lease in [base, max(base, cap)], monotone in the forecast', () => {
    const rng = new Rng(0x2305);
    for (let i = 0; i < 1000; i++) {
      const base = rng.range(5, 40);
      const cap = rng.range(0, 150);
      const d1 = rng.chance(0.2) ? 0 : rng.range(0, 200);
      const d2 = d1 + rng.range(0, 50);
      const l1 = plannedLeaseS(base, cap, d1, base / 4, 5);
      const l2 = plannedLeaseS(base, cap, d2, base / 4, 5);
      expect(l1).toBeGreaterThanOrEqual(base);
      expect(l1).toBeLessThanOrEqual(Math.max(base, cap));
      expect(l2).toBeGreaterThanOrEqual(l1);
    }
  });
});
