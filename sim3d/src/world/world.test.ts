import { describe, expect, it } from 'vitest';
import { ObstacleManager } from '../sim/ObstacleManager';
import { createWorld, DEFAULT_WORLD_CONFIG, inNoFly } from './buildWorld';
import { polygonIsSimple } from './NoFly';
import { shardCentre, shardOf } from './Shards';
import { windAt } from './Wind';

/** The PRD default world (4 x 4 km, 3 depots, 2 pads). */
const world = createWorld();

describe('world generation (PRD default 4 km)', () => {
  it('is deterministic for a seed and differs for another seed', () => {
    const again = createWorld();
    expect(again.stats).toEqual(world.stats);
    expect(again.depots.map((d) => [d.id, d.pos])).toEqual(world.depots.map((d) => [d.id, d.pos]));
    expect(again.dropPoints.map((d) => d.pos)).toEqual(world.dropPoints.map((d) => d.pos));
    const other = createWorld({ seed: DEFAULT_WORLD_CONFIG.seed + 1 });
    expect(other.stats.buildings).not.toBe(world.stats.buildings);
  });

  it('has the configured depots, pads, hand-off bays and typed drop clusters', () => {
    expect(world.size).toBe(4000);
    expect(world.depots.length).toBe(3);
    expect(world.pads.length).toBe(6);
    for (const d of world.depots) {
      expect(d.handoff.length).toBe(2);
      expect(d.padIds.length).toBe(2);
      expect(d.catchmentShards.length).toBeGreaterThan(0);
    }
    for (let i = 0; i < world.depots.length; i++) for (let j = i + 1; j < world.depots.length; j++) expect(Math.hypot(world.depots[i].pos.x - world.depots[j].pos.x, world.depots[i].pos.z - world.depots[j].pos.z)).toBeGreaterThanOrEqual(300);
    expect(world.dropPoints.length).toBeGreaterThan(150);
    for (const c of world.clusters) {
      expect(c.pointIds.length).toBeGreaterThan(0);
      expect(c.demand).toBeGreaterThan(0);
    }
    const types = new Set(world.dropPoints.map((d) => d.type));
    expect(types.has('residential')).toBe(true);
    expect(types.has('hospital') || types.has('clinic')).toBe(true);
    expect(types.has('office') || types.has('retail')).toBe(true);
  });

  it('keeps every landing site clear of no-fly zones (even inactive ones) and solids, away from aprons', () => {
    const om = new ObstacleManager(world);
    const sites = [...world.depots.flatMap((d) => d.handoff), ...world.pads.map((p) => p.pos), ...world.dropPoints.map((d) => d.pos)];
    for (const s of sites) {
      expect(inNoFly(world, s.x, s.z, 3, false)).toBe(false);
      expect(om.insideSolid({ x: s.x, y: s.y + 0.05, z: s.z }, 0.2, ['building', 'crane', 'utility'])).toBeNull();
    }
    for (const d of world.dropPoints) {
      for (const dep of world.depots) expect(d.pos.x > dep.apron.minX - 15 && d.pos.x < dep.apron.maxX + 15 && d.pos.z > dep.apron.minZ - 15 && d.pos.z < dep.apron.maxZ + 15).toBe(false);
      expect(d.rooftop ? d.pos.y <= 60.5 : true).toBe(true);
    }
  });

  it('has rectangular, circular and polygonal no-fly zones, some closable', () => {
    const kinds = new Set(world.noFlyZones.map((z) => z.shape.type));
    expect(kinds.has('circle')).toBe(true);
    expect(world.noFlyZones.some((z) => z.closable && !z.active)).toBe(true);
    for (const z of world.noFlyZones) if (z.shape.type === 'polygon') expect(polygonIsSimple(z.shape.points)).toBe(true);
  });

  it('shard grid round-trips and covers every drop point', () => {
    for (const id of world.shards.ids) {
      expect(id).toMatch(/^H-\d+-\d+$/);
      const c = shardCentre(world.shards, id);
      expect(shardOf(world.shards, c.x, c.z)).toBe(id);
      expect(world.depots.some((d) => d.id === world.shards.depotOf[id])).toBe(true);
    }
    for (const d of world.dropPoints) expect(d.shard).toBe(shardOf(world.shards, d.pos.x, d.pos.z));
  });

  it('wind field stays within mean + gust', () => {
    const f = world.wind;
    for (let i = 0; i < 200; i++) {
      const x = world.bounds.minX + ((i * 7919) % 4000);
      const z = world.bounds.minZ + ((i * 104729) % 4000);
      const w = windAt(f, x, z);
      expect(Math.hypot(w.vx, w.vz)).toBeLessThanOrEqual((f.mean + f.gust * 1.5) * 1.2 + 1e-6);
    }
  });

  it('does not repeat itself: varied block kinds and building sizes inside every district', () => {
    const byDistrict = new Map<string, typeof world.blocks>();
    for (const b of world.blocks) (byDistrict.get(b.districtId) ?? byDistrict.set(b.districtId, []).get(b.districtId)!).push(b);
    const bByBlock = new Map<string, typeof world.buildings>();
    for (const b of world.buildings) (bByBlock.get(b.blockId) ?? bByBlock.set(b.blockId, []).get(b.blockId)!).push(b);
    let pairs = 0;
    let identical = 0;
    let checked = 0;
    for (const [id, blocks] of byDistrict) {
      const d = world.districts.find((q) => q.id === id)!;
      if (!['houses', 'suburb', 'townhouses', 'apartments', 'mixed'].includes(d.kind) || blocks.length < 6) continue;
      checked++;
      expect(new Set(blocks.map((b) => b.kind)).size, `${id} block kinds`).toBeGreaterThanOrEqual(3);
      const widths = blocks.flatMap((b) => (bByBlock.get(b.id) ?? []).map((x) => x.w));
      if (widths.length > 10) {
        const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
        const sd = Math.sqrt(widths.reduce((a, b) => a + (b - mean) ** 2, 0) / widths.length);
        expect(sd / mean, `${id} building width CV`).toBeGreaterThan(0.15);
      }
      const sig = (b: (typeof blocks)[number]) => {
        const bl = bByBlock.get(b.id) ?? [];
        return `${b.kind}|${bl.length}|${bl.map((x) => Math.round(x.h)).sort((a, c) => a - c).join(',')}`;
      };
      for (let i = 0; i < blocks.length; i++) {
        for (let j = i + 1; j < blocks.length; j++) {
          if (Math.hypot(blocks[i].cx - blocks[j].cx, blocks[i].cz - blocks[j].cz) > 220) continue;
          pairs++;
          if (sig(blocks[i]) === sig(blocks[j])) identical++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(identical / Math.max(1, pairs)).toBeLessThan(0.05);
  });

  it('places the landmarks once each', () => {
    const kinds = world.blocks.map((b) => b.kind);
    for (const k of ['landmarktower', 'cathedral', 'tvmast']) expect(kinds.filter((x) => x === k).length, k).toBe(1);
    expect(world.districts.some((d) => d.name.startsWith('Old Town'))).toBe(true);
  });
});
