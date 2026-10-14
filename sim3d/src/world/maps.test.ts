import { describe, expect, it } from 'vitest';
import { MAPS } from '../map/registry';
import { scenariosForMap } from '../scenario/registry';
import { worldConfigFrom } from '../scenario/load';
import { ObstacleManager } from '../sim/ObstacleManager';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld, inNoFly } from './buildWorld';
import { featuresForSize } from './features';
import type { WorldData } from './types';

/**
 * Property tests over every shipped map (TC-M2). The 12 km map is excluded: it is pinned by the golden
 * hash and is too heavy for the default run.
 */
const MAP_IDS = Object.keys(MAPS).filter((id) => id !== 'harbour_metro_xl');
const worlds = new Map<string, { world: WorldData; scenario: ReturnType<typeof scenariosForMap>[number] }>();
for (const id of MAP_IDS) {
  const scenario = scenariosForMap(id)[0];
  if (scenario) worlds.set(id, { world: createWorld(worldConfigFrom(scenario)), scenario });
}

describe.each([...worlds.keys()])('map %s', (id) => {
  const { world, scenario } = worlds.get(id)!;
  const map = MAPS[id];

  it('has depots with pads, drop points and clusters', () => {
    expect(world.depots.length).toBeGreaterThanOrEqual(1);
    for (const d of world.depots) expect(d.padIds.length).toBeGreaterThanOrEqual(1);
    expect(world.dropPoints.length).toBeGreaterThan(10);
    expect(world.clusters.length).toBeGreaterThan(0);
    expect(world.stats.landKm2).toBeGreaterThan(0);
  });

  it('matches its depot layout', () => {
    const counts = world.depots.map((d) => d.padIds.length);
    const { layout, pads } = map.logistics.depots;
    if (layout === 'micro') expect(counts.every((c) => c === 1)).toBe(true);
    else if (layout === 'hub_and_spoke') {
      expect(counts[0]).toBe(pads);
      expect(counts.slice(1).every((c) => c === 1)).toBe(true);
    } else if (layout === 'single_hub') expect(counts).toEqual([pads]);
    else expect(counts.every((c) => c === pads)).toBe(true);
  });

  it('keeps every landing site clear of no-fly zones and solids', () => {
    const om = new ObstacleManager(world);
    const sites = [...world.depots.flatMap((d) => d.handoff), ...world.pads.map((p) => p.pos), ...world.dropPoints.map((d) => d.pos)];
    for (const s of sites) {
      expect(inNoFly(world, s.x, s.z, 3, false)).toBe(false);
      expect(om.insideSolid({ x: s.x, y: s.y + 0.05, z: s.z }, 0.2, ['building', 'crane', 'utility'])).toBeNull();
    }
  });

  it('puts nothing below the ground plane and keeps everything inside the bounds', () => {
    const b = world.bounds;
    for (const bd of world.buildings) {
      expect(bd.baseY).toBeGreaterThanOrEqual(0);
      expect(bd.cx).toBeGreaterThan(b.minX);
      expect(bd.cx).toBeLessThan(b.maxX);
    }
    for (const p of world.pads) expect(p.pos.y).toBeGreaterThan(0);
  });

  it('follows its water, rooftop and generation flags', () => {
    const w = map.geography.water;
    expect(!!world.coast).toBe(w === 'coast' || w === 'coast_river');
    expect(world.rivers.length > 0).toBe(w === 'river' || w === 'coast_river');
    if (map.logistics.rooftop_only) expect(world.dropPoints.every((d) => d.rooftop)).toBe(true);
    if (map.geography.district_bias?.farmland) expect(world.districts.some((d) => d.kind === 'farmland')).toBe(true);
    if (map.geography.tall_buildings === false) expect(world.buildings.some((b) => b.kind === 'tower' && b.h > 150)).toBe(false);
  });

  it('is deterministic', () => {
    const again = createWorld(worldConfigFrom(scenario));
    expect(again.stats).toEqual(world.stats);
    expect(again.depots.map((d) => d.pos)).toEqual(world.depots.map((d) => d.pos));
    expect(again.dropPoints.map((d) => d.pos)).toEqual(world.dropPoints.map((d) => d.pos));
  });

  it('runs 5 simulated minutes without collisions and delivers parcels', () => {
    const eng = new SimulationEngine(world, scenario);
    eng.start();
    for (let i = 0; i < 20 * 300; i++) eng.update(0.05);
    const s = eng.snapshot();
    expect(s.collisions).toBe(0);
    expect(s.structureHits).toBe(0);
    expect(s.completed).toBeGreaterThanOrEqual(2);
  });
});

describe('generator feature flags', () => {
  const base = { seed: 777, size: 3000, depots: 2, padsPerDepot: 2, dropPointsPerKm2: 30, noFly: ['auto' as const], wind: { mean_mps: 4 } };

  it.each([
    ['coast', true, 0],
    ['river', false, 1],
    ['none', false, 0],
  ] as const)('water mode %s', (water, hasCoast, rivers) => {
    const w = createWorld({ ...base, features: { ...featuresForSize(3000), water, port: false } });
    expect(!!w.coast).toBe(hasCoast);
    expect(w.rivers.length).toBe(rivers);
    expect(w.depots.length).toBe(2);
    if (water !== 'coast') expect(w.districts.every((d) => d.kind !== 'water' || rivers > 0)).toBe(true);
  });

  it('a single hub is one depot with up to six pads inside its apron', () => {
    const w = createWorld({ ...base, depots: 5, padsPerDepot: 6, depotLayout: 'single_hub' });
    expect(w.depots.length).toBe(1);
    expect(w.depots[0].padIds.length).toBe(6);
    const a = w.depots[0].apron;
    const padPos = w.pads.map((p) => p.pos);
    for (const p of padPos) {
      expect(p.x).toBeGreaterThan(a.minX - 1);
      expect(p.x).toBeLessThan(a.maxX + 1);
      expect(p.z).toBeGreaterThan(a.minZ - 1);
      expect(p.z).toBeLessThan(a.maxZ + 1);
    }
  });

  it('hub-and-spoke gives the hub the full pad count and the spokes one each', () => {
    const w = createWorld({ ...base, depots: 4, padsPerDepot: 3, depotLayout: 'hub_and_spoke' });
    expect(w.depots.map((d) => d.padIds.length)).toEqual([3, 1, 1, 1]);
  });

  it('default features reproduce the size-derived legacy values', () => {
    const small = featuresForSize(2000);
    expect(small.airport).toBe(false);
    expect(small.motorwayRing).toBe(false);
    expect(small.turbines).toBe(0);
    const xl = featuresForSize(12000);
    expect(xl.airport && xl.port && xl.rail && xl.motorwayRing && xl.tall).toBe(true);
    expect(xl.turbines).toBe(5);
    expect(xl.secondaryCentres).toBe(3);
  });
});
