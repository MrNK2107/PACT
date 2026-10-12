import type { WorldData } from './types';

/** FNV-1a (32-bit) over a string, hex encoded. Deterministic and dependency free. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const r = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Stable fingerprint of a generated world. Hashes only the listed fields, so adding new optional
 * fields to WorldData does not move existing pins (docs: TC-M0 determinism lock).
 */
export function worldHash(w: WorldData): string {
  const v = (p: { x: number; y: number; z: number }) => [r(p.x), r(p.y), r(p.z)];
  const payload = {
    stats: w.stats,
    bounds: w.bounds,
    buildings: w.buildings.map((b) => [b.id, r(b.cx), r(b.cz), r(b.w), r(b.d), r(b.h), r(b.baseY), b.kind]),
    trees: w.trees.map((t) => [r(t.x), r(t.z), r(t.height), r(t.radius)]),
    depots: w.depots.map((d) => [d.id, v(d.pos), d.handoff.map(v), d.padIds]),
    pads: w.pads.map((p) => [p.id, v(p.pos), p.rooftop]),
    chargers: w.chargers.map((c) => [c.id, v(c.pos)]),
    drops: w.dropPoints.map((d) => [d.id, v(d.pos), d.rooftop, d.shard, d.nearestDepotId, d.type]),
    noFly: w.noFlyZones.map((z) => [z.id, z.shape, z.maxY, z.closable, z.active]),
    obstacles: w.obstacles.map((o) => [o.id, o.bounds]),
    dyn: w.dynamicObstacles,
    roads: w.roads.map((q) => [q.id, q.dir, r(q.c), r(q.a), r(q.b)]),
    wind: Array.from(w.wind.vx.slice(0, 64)).map(r).concat(Array.from(w.wind.vz.slice(0, 64)).map(r)),
  };
  return fnv1a(JSON.stringify(payload));
}
