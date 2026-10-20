import { describe, expect, it } from 'vitest';
import { worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { createWorld } from './buildWorld';
import { featuresForSize } from './features';
import { labelLandmasses, makeLandMask } from './LandMask';
import { heightAt } from './Terrain';

describe('land masks', () => {
  it('place several separate islands, deterministically', () => {
    for (const seed of [1, 31005, 424242]) {
      const m = makeLandMask('islands', seed, 6000);
      const L = labelLandmasses(m, 6000);
      expect(L.areaKm2.length).toBeGreaterThanOrEqual(3);
      expect(L.areaKm2.filter((a) => a >= 0.5).length).toBeGreaterThanOrEqual(3);
      const again = makeLandMask('islands', seed, 6000);
      for (const [x, z] of [[0, 0], [1234, -987], [-2500, 2500]]) expect(again(x, z)).toBe(m(x, z));
    }
  });

  it('keep the map edge in open water', () => {
    const m = makeLandMask('islands', 31005, 6000);
    for (let t = -3000; t <= 3000; t += 250) {
      expect(m(t, -3000)).toBeLessThanOrEqual(0);
      expect(m(-3000, t)).toBeLessThanOrEqual(0);
    }
  });

  it('a lake mask is one landmass with water inside', () => {
    const m = makeLandMask('lake', 31005, 6000);
    expect(labelLandmasses(m, 6000).areaKm2.length).toBe(1);
    expect(m(480, -360)).toBeLessThan(0); // near the lake centre
    expect(m(-2800, 2800)).toBeGreaterThan(0);
  });

  it('labels landmasses and reports their area', () => {
    const m = (x: number, z: number) => (Math.hypot(x - 500, z) < 300 ? 1 : Math.hypot(x + 700, z) < 200 ? 1 : -1);
    const L = labelLandmasses(m, 3000);
    expect(L.areaKm2.length).toBe(2);
    expect(L.of(500, 0)).not.toBe(L.of(-700, 0));
    expect(L.of(0, 1000)).toBe(-1);
    expect(L.areaKm2[0]).toBeGreaterThan(L.areaKm2[1]);
  });
});

describe('archipelago world', () => {
  const scn = getScenario('ia_healthy');
  const cfg = worldConfigFrom(scn);
  const w = createWorld(cfg);
  const mask = makeLandMask('islands', cfg.seed, cfg.size);
  const lm = labelLandmasses(mask, cfg.size);

  it('is open water with no coast line or river', () => {
    expect(w.openWater).toBe(true);
    expect(w.coast).toBeNull();
    expect(w.rivers).toHaveLength(0);
    expect(w.terrain.flat).toBe(false);
  });

  it('builds nothing in the water', () => {
    for (const b of w.buildings) expect(mask(b.cx, b.cz), b.id).toBeGreaterThan(0);
    for (const d of w.dropPoints) expect(mask(d.pos.x, d.pos.z), d.id).toBeGreaterThan(0);
    for (const p of w.pads) expect(mask(p.pos.x, p.pos.z), p.id).toBeGreaterThan(0);
    for (const t of w.trees.slice(0, 2000)) expect(mask(t.x, t.z)).toBeGreaterThan(0);
  });

  it('carves the sea bed and keeps the land above the water plane', () => {
    for (let x = -2900; x <= 2900; x += 97) {
      for (let z = -2900; z <= 2900; z += 101) {
        const h = heightAt(w.terrain, x, z);
        if (mask(x, z) <= -30) expect(h).toBeLessThan(-2);
        else if (mask(x, z) >= 30) expect(h).toBeGreaterThanOrEqual(0.39);
      }
    }
  });

  it('gives each of the largest islands its own depot', () => {
    const ids = w.depots.map((d) => lm.of(d.pos.x, d.pos.z));
    expect(ids.every((id) => id >= 0)).toBe(true);
    const largest = lm.areaKm2.map((a, id) => ({ a, id })).sort((p, q) => q.a - p.a).slice(0, Math.min(w.depots.length, lm.areaKm2.length));
    for (const { id } of largest) expect(ids, `island ${id}`).toContain(id);
  });

  it('keeps roads on land except for short bridges', () => {
    for (const r of w.roads) {
      for (let t = r.a; t <= r.b; t += 20) {
        const x = r.dir === 'EW' ? t : r.c;
        const z = r.dir === 'EW' ? r.c : t;
        if (mask(x, z) > 0) continue;
        const onBridge = (r.bridges ?? []).some((b) => t >= b.a - 1 && t <= b.b + 1);
        expect(onBridge, `${r.id} at ${t}`).toBe(true);
      }
    }
  });

  it('gets extra wind over open water', () => {
    // the water boost multiplies the whole vector, so water cells are windier than land cells on average
    const f = w.wind;
    let wet = 0;
    let wetN = 0;
    let dry = 0;
    let dryN = 0;
    for (let j = 0; j < f.nz; j += 2) {
      for (let i = 0; i < f.nx; i += 2) {
        const sp = Math.hypot(f.vx[j * f.nx + i], f.vz[j * f.nx + i]);
        if (mask(f.originX + i * f.cell, f.originZ + j * f.cell) <= 0) {
          wet += sp;
          wetN++;
        } else {
          dry += sp;
          dryN++;
        }
      }
    }
    expect(wet / wetN).toBeGreaterThan((dry / dryN) * 1.05);
  });
});

describe('lake world', () => {
  const base = { seed: 777, size: 3000, depots: 2, padsPerDepot: 2, dropPointsPerKm2: 30, noFly: ['auto' as const], wind: { mean_mps: 4 } };
  const features = { ...featuresForSize(3000), water: 'lake' as const, port: false };
  const w = createWorld({ ...base, features });
  const mask = makeLandMask('lake', 777, 3000);

  it('has a lake in the middle and a town around it', () => {
    expect(w.openWater).toBe(true);
    expect(w.depots.length).toBe(2);
    expect(w.districts.some((d) => d.kind === 'water' || d.kind === 'waterfront')).toBe(true);
    for (const b of w.buildings) expect(mask(b.cx, b.cz)).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = createWorld({ ...base, features });
    expect(again.stats).toEqual(w.stats);
  });
});
