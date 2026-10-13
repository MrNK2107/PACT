import type { BuildContext } from './BuildContext';
import type { CityLayout, SuperBlock } from './CityLayout';
import { inNoFly } from './NoFly';
import type { Noise2D } from './noise';
import type { Rng } from './rng';
import { shardOf } from './Shards';
import type { DemandCluster, DepotData, DistrictKind, DropPointData, DropType, NoFlyZone, ShardGrid } from './types';

/**
 * Drop points are grouped into demand clusters (one per district, plus small clinic clusters in some
 * residential districts) so the workload generator can produce *clustered* demand (REQ-SIM-005).
 * Each cluster type carries a priority affinity used when a task of a given priority is sampled.
 */

export const BASE_DEMAND: Record<DropType, number> = { hospital: 6, clinic: 3, office: 4, retail: 3.5, residential: 1.2, industrial: 1.5, campus: 2, event: 2.5, park: 0.4 };

/** P(cluster type | priority) weights, rows = [p1, p2, p3]. */
export const PRIORITY_AFFINITY: Record<DropType, [number, number, number]> = {
  hospital: [0.55, 0.35, 0.1],
  clinic: [0.35, 0.45, 0.2],
  office: [0.08, 0.52, 0.4],
  retail: [0.05, 0.4, 0.55],
  residential: [0.03, 0.22, 0.75],
  industrial: [0.08, 0.42, 0.5],
  campus: [0.08, 0.42, 0.5],
  event: [0.2, 0.5, 0.3],
  park: [0.01, 0.19, 0.8],
};

export function dropTypeFor(kind: DistrictKind): DropType | null {
  switch (kind) {
    case 'hospital':
      return 'hospital';
    case 'campus':
      return 'campus';
    case 'cbd':
    case 'commercial':
      return 'office';
    case 'mixed':
      return 'retail';
    case 'apartments':
    case 'townhouses':
    case 'houses':
    case 'suburb':
      return 'residential';
    case 'industrial':
    case 'logistics':
    case 'port':
      return 'industrial';
    case 'stadium':
      return 'event';
    case 'farmland':
      return 'residential';
    case 'park':
    case 'waterfront':
    case 'cemetery':
      return 'park';
    default:
      return null;
  }
}

export interface ClusterPlan {
  district: SuperBlock;
  type: DropType;
  cx: number;
  cz: number;
  radius: number;
  demand: number;
}

/** District-level demand clusters, computed before any building exists (used for depot siting too). */
export function planClusters(layout: CityLayout, noise: Noise2D, rng: Rng): ClusterPlan[] {
  const out: ClusterPlan[] = [];
  for (const d of layout.districts) {
    const type = dropTypeFor(d.kind);
    if (!type) continue;
    const w = d.maxX - d.minX;
    const h = d.maxZ - d.minZ;
    const areaKm2 = (w * h) / 1e6;
    const cx = (d.minX + d.maxX) / 2;
    const cz = (d.minZ + d.maxZ) / 2;
    const n = noise.fbm(cx + 300, cz - 900, 1500, 2);
    const demand = BASE_DEMAND[type] * areaKm2 * (0.5 + d.centrality) * (0.7 + 0.6 * n) * (1 - d.waterFrac);
    if (demand <= 0) continue;
    out.push({ district: d, type, cx, cz, radius: Math.hypot(w, h) / 2, demand });
    if ((d.kind === 'apartments' || d.kind === 'townhouses') && rng.chance(0.3)) {
      out.push({ district: d, type: 'clinic', cx, cz, radius: Math.hypot(w, h) / 4, demand: BASE_DEMAND.clinic * 0.3 });
    }
  }
  return out;
}

export function generateDropPoints(
  plans: ClusterPlan[],
  ctx: BuildContext,
  depots: DepotData[],
  noFly: NoFlyZone[],
  shards: ShardGrid,
  cfg: { dropPointsPerKm2: number; landKm2: number; groundY: number; rooftopOnly?: boolean },
  rng: Rng,
): { clusters: DemandCluster[]; dropPoints: DropPointData[] } {
  const clusters: DemandCluster[] = [];
  const dropPoints: DropPointData[] = [];
  const total = Math.max(plans.length, Math.round(cfg.dropPointsPerKm2 * cfg.landKm2));
  let sum = 0;
  for (const p of plans) sum += p.demand;
  const buildingById = new Map(ctx.buildings.map((b) => [b.id, b]));
  const groundByDistrict = new Map<string, typeof ctx.groundSites>();
  for (const g of ctx.groundSites) {
    let l = groundByDistrict.get(g.districtId);
    if (!l) groundByDistrict.set(g.districtId, (l = []));
    l.push(g);
  }
  const roofByDistrict = new Map<string, typeof ctx.roofSites>();
  for (const r of ctx.roofSites) {
    let l = roofByDistrict.get(r.districtId);
    if (!l) roofByDistrict.set(r.districtId, (l = []));
    l.push(r);
  }
  // ground candidates must not sit inside a building footprint (fillers may place a building after a site)
  const fp = new Map<number, { minX: number; maxX: number; minZ: number; maxZ: number; maxY: number; id: string }[]>();
  const fkey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
  for (const b of ctx.buildings) {
    const r = { minX: b.bounds.minX - 2, maxX: b.bounds.maxX + 2, minZ: b.bounds.minZ - 2, maxZ: b.bounds.maxZ + 2, maxY: b.bounds.maxY, id: b.id };
    for (let i = Math.floor(r.minX / 40); i <= Math.floor(r.maxX / 40); i++) for (let j = Math.floor(r.minZ / 40); j <= Math.floor(r.maxZ / 40); j++) (fp.get(fkey(i, j)) ?? fp.set(fkey(i, j), []).get(fkey(i, j))!).push(r);
  }
  /** Something solid occupies the column above (x, z, y): a building other than `self` whose footprint contains the point and rises above y. */
  const overhung = (x: number, z: number, y: number, self?: string) => (fp.get(fkey(Math.floor(x / 40), Math.floor(z / 40))) ?? []).some((r) => r.id !== self && r.maxY > y + 0.5 && x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
  const nearApron = (x: number, z: number) => depots.some((d) => x > d.apron.minX - 15 && x < d.apron.maxX + 15 && z > d.apron.minZ - 15 && z < d.apron.maxZ + 15);
  const nearestDepot = (x: number, z: number) => {
    let best = depots[0];
    let bd = Infinity;
    for (const d of depots) {
      const dd = (d.pos.x - x) ** 2 + (d.pos.z - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best.id;
  };
  const used: { x: number; z: number }[] = [];
  let seq = 0;
  plans.forEach((p, i) => {
    const want = Math.max(1, Math.min(14, Math.round((p.demand / sum) * total)));
    const id = `CL-${String(i + 1).padStart(3, '0')}`;
    const cluster: DemandCluster = { id, districtId: p.district.id, type: p.type, cx: p.cx, cz: p.cz, radius: p.radius, demand: p.demand, pointIds: [] };
    // dense-city maps allow rooftop drops only
    const grounds = cfg.rooftopOnly ? [] : (groundByDistrict.get(p.district.id) ?? []).slice();
    const roofs = (roofByDistrict.get(p.district.id) ?? []).slice();
    // shuffle deterministically
    const shuffle = <T>(a: T[]) => {
      for (let k = a.length - 1; k > 0; k--) {
        const j = rng.int(0, k);
        [a[k], a[j]] = [a[j], a[k]];
      }
      return a;
    };
    shuffle(grounds);
    shuffle(roofs);
    // prefer roofs for office / hospital, ground elsewhere; interleave the rest
    const cands: { x: number; y: number; z: number; name: string; buildingId?: string; rooftop: boolean }[] = [];
    const roofFirst = p.type === 'office' || p.type === 'hospital' || p.type === 'clinic';
    const A = roofFirst ? roofs.map((r) => ({ x: r.x, y: r.y + 0.15, z: r.z, name: r.name, buildingId: r.buildingId, rooftop: true })) : grounds.map((g) => ({ x: g.x, y: cfg.groundY, z: g.z, name: g.name, buildingId: g.buildingId, rooftop: false }));
    const B = roofFirst ? grounds.map((g) => ({ x: g.x, y: cfg.groundY, z: g.z, name: g.name, buildingId: g.buildingId, rooftop: false })) : roofs.map((r) => ({ x: r.x, y: r.y + 0.15, z: r.z, name: r.name, buildingId: r.buildingId, rooftop: true }));
    const n = Math.max(A.length, B.length);
    for (let k = 0; k < n; k++) {
      if (k < A.length) cands.push(A[k]);
      if (k < B.length && k % 2 === 1) cands.push(B[k]);
    }
    for (let k = 0; k < B.length; k++) if (k % 2 === 0) cands.push(B[k]);
    for (const c of cands) {
      if (cluster.pointIds.length >= want) break;
      if (inNoFly(noFly, c.x, c.z, 3, false) || nearApron(c.x, c.z)) continue;
      if (c.rooftop && c.y > 60) continue; // rooftop drops stay well under the flight ceiling
      if (overhung(c.x, c.z, c.y, c.rooftop ? c.buildingId : undefined)) continue;
      if (used.some((u) => Math.abs(u.x - c.x) < 15 && Math.abs(u.z - c.z) < 15)) continue;
      used.push({ x: c.x, z: c.z });
      const pid = `DP-${String(++seq).padStart(4, '0')}`;
      const bld = c.buildingId ? buildingById.get(c.buildingId) : undefined;
      dropPoints.push({
        id: pid,
        name: c.name,
        kind: 'drop',
        type: p.type,
        zone: bld?.zone ?? dropZone(p.type),
        clusterId: id,
        pos: { x: c.x, y: c.y, z: c.z },
        buildingId: c.buildingId,
        rooftop: c.rooftop,
        demand: (p.demand / want) * rng.range(0.6, 1.4),
        shard: shardOf(shards, c.x, c.z),
        nearestDepotId: nearestDepot(c.x, c.z),
      });
      cluster.pointIds.push(pid);
    }
    if (cluster.pointIds.length) clusters.push(cluster);
  });
  return { clusters, dropPoints };
}

function dropZone(t: DropType): DropPointData['zone'] {
  return t === 'office' || t === 'retail' ? 'commercial' : t === 'industrial' ? 'industrial' : t === 'park' ? 'park' : t === 'hospital' || t === 'campus' || t === 'event' ? 'civic' : 'residential';
}
