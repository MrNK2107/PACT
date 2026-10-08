import type { ShardGrid, WorldBounds } from './types';

/**
 * Pointy-top hexagonal shard grid, 500 m flat-to-flat (PRD section 15). Shard ids `H-<q>-<r>` use
 * axial coordinates offset by +64 so they are non-negative. Shards are the unit of the ownership
 * protocol's shard leases (03 section 3.5d); here they also label every task and drop point.
 */
const OFFSET = 64;

function hexSize(flatToFlat: number): number {
  // circumradius R for a pointy-top hex of width (flat-to-flat) w: w = sqrt(3) R
  return flatToFlat / Math.sqrt(3);
}

export function shardOf(g: ShardGrid, x: number, z: number): string {
  const R = hexSize(g.size);
  const px = x - g.originX;
  const pz = z - g.originZ;
  const q = ((Math.sqrt(3) / 3) * px - (1 / 3) * pz) / R;
  const r = ((2 / 3) * pz) / R;
  const [cq, cr] = roundAxial(q, r);
  return `H-${cq + OFFSET}-${cr + OFFSET}`;
}

function roundAxial(q: number, r: number): [number, number] {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return [rq, rr];
}

export function parseShard(id: string): [number, number] {
  const m = /^H-(\d+)-(\d+)$/.exec(id);
  if (!m) throw new Error(`bad shard id ${id}`);
  return [Number(m[1]) - OFFSET, Number(m[2]) - OFFSET];
}

export function shardCentre(g: ShardGrid, id: string): { x: number; z: number } {
  const [q, r] = parseShard(id);
  const R = hexSize(g.size);
  return { x: g.originX + R * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r), z: g.originZ + R * 1.5 * r };
}

export function shardPolygon(g: ShardGrid, id: string): { x: number; z: number }[] {
  const c = shardCentre(g, id);
  const R = hexSize(g.size);
  const out: { x: number; z: number }[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (Math.PI / 180) * (60 * k - 30);
    out.push({ x: c.x + R * Math.cos(a), z: c.z + R * Math.sin(a) });
  }
  return out;
}

/** Enumerates every shard whose centre lies inside the bounds and assigns it to the nearest depot. */
export function createShardGrid(bounds: WorldBounds, depots: { id: string; pos: { x: number; z: number } }[], size = 500): ShardGrid {
  const g: ShardGrid = { size, originX: 0, originZ: 0, ids: [], depotOf: {} };
  const R = hexSize(size);
  const seen = new Set<string>();
  const step = size / 2;
  for (let z = bounds.minZ - R; z <= bounds.maxZ + R; z += step) {
    for (let x = bounds.minX - R; x <= bounds.maxX + R; x += step) {
      const id = shardOf(g, x, z);
      if (seen.has(id)) continue;
      const c = shardCentre(g, id);
      if (c.x < bounds.minX || c.x > bounds.maxX || c.z < bounds.minZ || c.z > bounds.maxZ) continue;
      seen.add(id);
      g.ids.push(id);
      let best = '';
      let bd = Infinity;
      for (const d of depots) {
        const dd = (d.pos.x - c.x) ** 2 + (d.pos.z - c.z) ** 2;
        if (dd < bd) {
          bd = dd;
          best = d.id;
        }
      }
      g.depotOf[id] = best;
    }
  }
  g.ids.sort();
  return g;
}
