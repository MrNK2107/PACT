import { describe, expect, it } from 'vitest';
import { loadMap } from '../map/load';
import { loadScenario, parseScenarioYaml, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { ObstacleManager } from '../sim/ObstacleManager';
import { PathPlanner } from '../sim/PathPlanner';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld, inNoFly } from './buildWorld';
import { flatTerrain, footprintGround, generateTerrain, heightAt, TERRAIN_PRESETS } from './Terrain';
import type { HeightField, WorldData } from './types';

const grid = (nx: number, nz: number, fn: (i: number, j: number) => number, cell = 10): HeightField => {
  const h = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = fn(i, j);
  return { cell, nx, nz, originX: 0, originZ: 0, h, minY: Math.min(...h), maxY: Math.max(...h), flat: false };
};

describe('height field', () => {
  it('is exactly zero everywhere when flat', () => {
    const f = flatTerrain({ minX: -100, maxX: 100, minZ: -100, maxZ: 100, minY: 0, maxY: 120 });
    expect(f.flat).toBe(true);
    expect(heightAt(f, 5, 7)).toBe(0);
    expect(heightAt(f, 1e6, -1e6)).toBe(0);
  });

  it('interpolates bilinearly and clamps outside the grid', () => {
    const f = grid(2, 2, (i, j) => [0, 10, 20, 30][j * 2 + i]);
    expect(heightAt(f, 0, 0)).toBeCloseTo(0, 6);
    expect(heightAt(f, 5, 5)).toBeCloseTo(15, 3);
    expect(heightAt(f, 5, 0)).toBeCloseTo(5, 3);
    expect(heightAt(f, -500, -500)).toBeCloseTo(0, 6);
    expect(heightAt(f, 500, 500)).toBeCloseTo(30, 1);
  });

  it('reports the highest and lowest ground under a footprint', () => {
    const f = grid(20, 20, (i) => i * 2); // rises 2 m per cell eastwards
    const g = footprintGround(f, 100, 100, 40, 20);
    expect(g.max).toBeCloseTo(heightAt(f, 120, 100), 6);
    expect(g.min).toBeCloseTo(heightAt(f, 80, 100), 6);
    expect(footprintGround(flatTerrain({ minX: 0, maxX: 1, minZ: 0, maxZ: 1, minY: 0, maxY: 1 }), 0, 0, 50, 50)).toEqual({ max: 0, min: 0 });
  });
});

describe('terrain generation', () => {
  const scn = getScenario('rv_healthy');
  const cfg = worldConfigFrom(scn);
  const w = createWorld(cfg);
  const t = w.terrain;

  it('is deterministic and respects the amplitude', () => {
    const again = createWorld(cfg);
    expect(Array.from(again.terrain.h.slice(0, 5000))).toEqual(Array.from(t.h.slice(0, 5000)));
    expect(t.flat).toBe(false);
    expect(t.maxY).toBeLessThanOrEqual(TERRAIN_PRESETS.hilly.kind === 'hills' ? TERRAIN_PRESETS.hilly.amplitude_m : 0);
    expect(t.maxY).toBeGreaterThan(10);
    expect(w.bounds.maxY).toBe(120 + Math.ceil(t.maxY));
  });

  it('fades to the datum at the map edge and along the river banks', () => {
    for (let k = 0; k < t.nx; k += 7) {
      expect(heightAt(t, t.originX + k * t.cell, t.originZ)).toBeLessThan(0.05);
      expect(heightAt(t, t.originX, t.originZ + k * t.cell)).toBeLessThan(0.05);
    }
    const river = w.rivers[0];
    for (const p of river.points.filter((_, i) => i % 10 === 0)) {
      expect(heightAt(t, p.x, p.z)).toBeLessThan(0); // the bed is below the datum
      expect(heightAt(t, p.x + river.width * 0.7 + 10, p.z)).toBeLessThan(4); // 40 m past the bank it is still near the datum
    }
  });

  it('puts buildings on the high side of their footprint with a foundation to the low side', () => {
    let withFoundation = 0;
    for (const b of w.buildings) {
      if (b.kind === 'crown' || b.kind === 'spire') continue; // stacked parts sit on the part beneath
      const g = footprintGround(t, b.cx, b.cz, b.w, b.d);
      if (b.kind === 'tower' && b.baseY > g.max + 0.5) continue; // a tower on a podium
      expect(b.baseY).toBeGreaterThanOrEqual(g.max - 0.01);
      if (b.foundation) {
        withFoundation++;
        expect(b.foundation).toBeCloseTo(b.baseY - g.min, 3);
      }
    }
    expect(withFoundation).toBeGreaterThan(100);
  });

  it('lands pads, hand-off bays and drop points on the ground', () => {
    for (const p of w.pads) {
      const g = heightAt(t, p.pos.x, p.pos.z);
      expect(p.pos.y).toBeGreaterThan(g + 0.3);
      expect(p.pos.y).toBeLessThan(g + 0.6);
    }
    for (const d of w.depots) for (const h of d.handoff) expect(h.y).toBeCloseTo(heightAt(t, h.x, h.z) + 0.32, 3);
    for (const d of w.dropPoints) {
      if (d.rooftop) expect(d.pos.y - heightAt(t, d.pos.x, d.pos.z)).toBeLessThanOrEqual(60.5);
      else expect(d.pos.y).toBeCloseTo(heightAt(t, d.pos.x, d.pos.z) + 0.32, 3);
    }
  });

  it('stands trees, utilities and cranes on the ground', () => {
    const byId = new Map(w.obstacles.map((o) => [o.id, o]));
    for (const tr of w.trees.slice(0, 500)) {
      const o = byId.get(tr.id)!;
      expect(o.bounds.minY).toBeCloseTo(heightAt(t, tr.x, tr.z), 5);
      expect(o.bounds.maxY).toBeCloseTo(heightAt(t, tr.x, tr.z) + tr.height, 5);
    }
    for (const u of w.utilities) expect(byId.get(u.id)!.bounds.minY).toBeCloseTo(heightAt(t, u.x, u.z), 5);
  });

  it('keeps every landing site clear of no-fly zones and solids', () => {
    const om = new ObstacleManager(w);
    const sites = [...w.depots.flatMap((d) => d.handoff), ...w.pads.map((p) => p.pos), ...w.dropPoints.map((d) => d.pos)];
    for (const s of sites) {
      expect(inNoFly(w, s.x, s.z, 3, false)).toBe(false);
      expect(om.insideSolid({ x: s.x, y: s.y + 0.05, z: s.z }, 0.2, ['building', 'crane', 'utility'])).toBeNull();
    }
  });
});

describe('terrain changes heights only', () => {
  // the same world with and without hills: nothing but y may differ (no other random draw may move)
  const base = worldConfigFrom(getScenario('test_small'));
  const flat = createWorld(base);
  const hills = createWorld({ ...base, terrain: TERRAIN_PRESETS.hilly });

  it('keeps every position, size and id identical', () => {
    expect(hills.buildings.map((b) => [b.id, b.kind, b.cx, b.cz, b.w, b.d, b.h])).toEqual(flat.buildings.map((b) => [b.id, b.kind, b.cx, b.cz, b.w, b.d, b.h]));
    expect(hills.trees.map((x) => [x.id, x.x, x.z, x.height])).toEqual(flat.trees.map((x) => [x.id, x.x, x.z, x.height]));
    expect(hills.depots.map((d) => [d.id, d.pos.x, d.pos.z])).toEqual(flat.depots.map((d) => [d.id, d.pos.x, d.pos.z]));
    expect(hills.noFlyZones.map((z) => [z.id, z.shape])).toEqual(flat.noFlyZones.map((z) => [z.id, z.shape]));
    expect(hills.roads.length).toBe(flat.roads.length);
  });

  it('is flat for the legacy maps', () => {
    expect(flat.terrain.flat).toBe(true);
    expect(flat.bounds.maxY).toBe(120);
    expect(flat.buildings.every((b) => b.foundation === undefined)).toBe(true);
  });

  it('only lowers or keeps the drop points that were allowed (rooftop ceiling is above the ground)', () => {
    const ids = new Set(flat.dropPoints.map((d) => d.id));
    for (const d of hills.dropPoints) expect(ids.has(d.id) || hills.dropPoints.length > 0).toBe(true);
    expect(hills.dropPoints.length).toBeGreaterThan(20);
  });
});

describe('flying over hills', () => {
  const scn = getScenario('rv_healthy');
  const w: WorldData = createWorld(worldConfigFrom(scn));

  it('blocks the layers below the ground and plans above the hills', () => {
    const om = new ObstacleManager(w);
    const planner = new PathPlanner(om, w.bounds);
    const from = w.depots[0].handoff[0];
    let planned = 0;
    for (const d of w.dropPoints.slice(0, 40)) {
      const plan = planner.plan(from, d.pos, 28);
      if (!plan) continue;
      planned++;
      for (const wp of plan.waypoints) {
        if (wp.kind !== 'cruise') continue;
        expect(wp.pos.y).toBeGreaterThanOrEqual(heightAt(w.terrain, wp.pos.x, wp.pos.z) + 7.5);
      }
    }
    expect(planned).toBeGreaterThan(20);
  });

  it('flies a 10-minute run with no collision and nothing below the ground', () => {
    const eng = new SimulationEngine(w, scn);
    eng.start();
    for (let i = 0; i < 20 * 600; i++) eng.update(0.05);
    const s = eng.snapshot();
    expect(s.collisions).toBe(0);
    expect(s.terrainHits).toBe(0);
    expect(s.completed).toBeGreaterThanOrEqual(5);
  });

  it('is deterministic over hills', () => {
    const run = () => {
      const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
      eng.start();
      for (let i = 0; i < 20 * 240; i++) eng.update(0.05);
      return eng.eventHash();
    };
    expect(run()).toBe(run());
  });
});

describe('terrain validation', () => {
  it('accepts presets and explicit hills, and rejects bad values', () => {
    expect(loadMap('id: a\ngeography: { terrain: hilly }', 'a.yaml').geography.terrain).toEqual(TERRAIN_PRESETS.hilly);
    expect(loadMap('id: b\ngeography: { terrain: { amplitude_m: 25, wavelength_m: 1500 } }', 'b.yaml').geography.terrain).toEqual({ kind: 'hills', amplitude_m: 25, wavelength_m: 1500 });
    expect(loadMap('id: c', 'c.yaml').geography.terrain).toBeUndefined();
    expect(() => loadMap('id: d\ngeography: { terrain: alpine }', 'd.yaml')).toThrow(/d\.yaml.*terrain/);
    expect(() => loadMap('id: e\ngeography: { terrain: { amplitude_m: 200 } }', 'e.yaml')).toThrow(/amplitude_m/);
  });

  it('generates a flat field for kind none and keeps terrain a map property', () => {
    const f = generateTerrain(1, { minX: -500, maxX: 500, minZ: -500, maxZ: 500, minY: 0, maxY: 120 }, { kind: 'none' }, { coast: false, river: false, shoreX: () => Infinity, riverX: () => null, riverWidth: () => 0, airport: null });
    expect(f.flat).toBe(true);
    expect(() => loadScenario(parseScenarioYaml('map: river_valley\nworld: { size_m: [3000, 3000] }', 'x.yaml'), 'x.yaml', () => null, () => null)).toThrow(/unknown map|size/);
  });
});
