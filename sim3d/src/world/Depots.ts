import type { DepotBuild } from './BlockFillers';
import type { CityLayout, LayoutBlock } from './CityLayout';
import type { DepotLayout } from './features';
import { heightAt } from './Terrain';
import type { ChargerData, DepotData, HeightField, PadData } from './types';

/**
 * Depot siting. Depots are local resources (parcel hand-off + 1–3 scarce charging pads) spread over
 * the map with a k-centre rule weighted by centrality, then nudged towards demand with two Lloyd
 * iterations. The chosen blocks are marked `kind = 'depot'` and later built by `fillDepot`.
 */

export interface ClusterSeed {
  cx: number;
  cz: number;
  demand: number;
}

const CAND_TIERS: { kinds: string[]; w: number; d: number; maxArea: number }[] = [
  { kinds: ['logistics', 'industrial', 'port'], w: 90, d: 70, maxArea: 40000 },
  { kinds: ['logistics', 'industrial', 'port'], w: 90, d: 70, maxArea: Infinity },
  { kinds: ['commercial', 'mixed', 'apartments', 'suburb', 'houses', 'townhouses'], w: 90, d: 70, maxArea: 40000 },
  { kinds: [], w: 80, d: 60, maxArea: Infinity },
];

function fits(b: LayoutBlock, w: number, d: number, maxArea: number): boolean {
  return b.w * b.d <= maxArea && ((b.w >= w && b.d >= d) || (b.w >= d && b.d >= w));
}

/** Micro depots favour small blocks in residential / rural districts. */
const CAND_TIERS_MICRO: typeof CAND_TIERS = [
  { kinds: ['suburb', 'houses', 'farmland', 'townhouses'], w: 70, d: 55, maxArea: 40000 },
  { kinds: ['suburb', 'houses', 'farmland', 'townhouses', 'mixed', 'commercial'], w: 70, d: 55, maxArea: Infinity },
  { kinds: [], w: 70, d: 55, maxArea: Infinity },
];

/** A single hub is the operations centre: it goes where the town is, not into an industrial estate at the edge. */
const CAND_TIERS_HUB: typeof CAND_TIERS = [
  { kinds: ['logistics', 'industrial', 'commercial', 'mixed', 'apartments', 'townhouses', 'houses', 'suburb'], w: 90, d: 70, maxArea: Infinity },
  { kinds: [], w: 80, d: 60, maxArea: Infinity },
];

export interface Landmasses {
  of: (x: number, z: number) => number;
  areaKm2: number[];
}

/** A circle of airspace that a landmark block will later close (see fillStadium / fillHospital in BlockFillers). */
export interface AirspaceCircle {
  blockId: string;
  x: number;
  z: number;
  r: number;
}

/**
 * Forecasts the circular no-fly zones of the landmark blocks before they are filled, so depot siting can
 * keep clear of them. createWorld later gives the largest free block of every hospital / stadium district
 * that kind; the radii mirror the fillers exactly: the stadium event TFR is max(w, d) / 2 + 60 around the
 * block centre, and the helipad circle is 60 m around the main building (block centre, 6 m north).
 * No RNG is used, so the world's random streams are untouched.
 */
export function landmarkAirspace(layout: CityLayout): AirspaceCircle[] {
  const out: AirspaceCircle[] = [];
  const add = (b: LayoutBlock, kind: string) => {
    if (kind === 'stadium') out.push({ blockId: b.id, x: b.cx, z: b.cz, r: Math.max(Math.min(b.w - 40, 190), Math.min(b.d - 40, 150)) / 2 + 60 });
    else if (kind === 'hospital') out.push({ blockId: b.id, x: b.cx, z: b.cz - 6, r: 60 });
  };
  for (const b of layout.blocks) if (b.kind === 'stadium' || b.kind === 'hospital') add(b, b.kind);
  for (const d of layout.districts) {
    if (d.kind !== 'hospital' && d.kind !== 'stadium') continue;
    let best: LayoutBlock | null = null;
    for (const b of layout.blocks) if (b.districtId === d.id && !b.kind && (!best || b.w * b.d > best.w * best.d)) best = b;
    if (best) add(best, d.kind);
  }
  return out;
}

/** Margin around a depot block that its hand-off points reach (5 m outside the building) plus the 3 m check margin. */
const DEPOT_REACH_M = 8;

/** Whether any part of block `b` (grown by the depot reach) lies inside one of the airspace circles. */
export function blockInAirspace(b: LayoutBlock, zones: readonly AirspaceCircle[]): boolean {
  const hw = b.w / 2 + DEPOT_REACH_M;
  const hd = b.d / 2 + DEPOT_REACH_M;
  for (const z of zones) {
    const dx = Math.max(Math.abs(z.x - b.cx) - hw, 0);
    const dz = Math.max(Math.abs(z.z - b.cz) - hd, 0);
    if (dx * dx + dz * dz < z.r * z.r) return true;
  }
  return false;
}

export function siteDepotBlocks(layout: CityLayout, seeds: ClusterSeed[], n: number, kind: DepotLayout = 'distributed', landmass?: Landmasses): LayoutBlock[] {
  const minSep = kind === 'micro' ? 250 : layout.size < 2500 ? 300 : 600;
  const excluded = new Set(['airport', 'water', 'hospital', 'stadium']);
  // a block next to a stadium or hospital can sit under its airspace circle (which reaches across the street),
  // so those blocks are never candidates: depots must never sit inside a no-fly zone, even a closable one
  const airspace = landmarkAirspace(layout);
  const clear = (b: LayoutBlock) => !blockInAirspace(b, airspace);
  let cands: LayoutBlock[] = [];
  for (const tier of kind === 'micro' ? CAND_TIERS_MICRO : kind === 'single_hub' ? CAND_TIERS_HUB : CAND_TIERS) {
    cands = layout.blocks.filter((b) => !b.kind && !b.nearWater && !excluded.has(b.district) && (tier.kinds.length === 0 || tier.kinds.includes(b.district)) && fits(b, tier.w, tier.d, tier.maxArea) && clear(b));
    if (cands.length >= n) break;
  }
  if (!cands.length) cands = layout.blocks.filter((b) => !b.kind && !excluded.has(b.district) && clear(b));
  if (!cands.length) throw new Error('no depot candidates');
  const chosen: LayoutBlock[] = [];
  if (landmass) {
    // an archipelago: the largest islands get a depot each, on their most central candidate
    const order = landmass.areaKm2.map((a, id) => ({ a, id })).sort((p, q) => q.a - p.a || p.id - q.id);
    for (const { id } of order) {
      if (chosen.length >= n) break;
      const here = cands.filter((c) => landmass.of(c.cx, c.cz) === id);
      if (here.length) chosen.push(here.reduce((b, c) => (c.centrality > b.centrality ? c : b)));
    }
  }
  if (!chosen.length) {
    let best = cands[0];
    for (const c of cands) if (c.centrality > best.centrality) best = c;
    chosen.push(best);
  }
  const minDist = (c: LayoutBlock, list: LayoutBlock[]) => {
    let md = Infinity;
    for (const q of list) if (q !== c) md = Math.min(md, Math.hypot(q.cx - c.cx, q.cz - c.cz));
    return md;
  };
  while (chosen.length < n) {
    let pick: LayoutBlock | null = null;
    let score = -Infinity;
    for (const c of cands) {
      if (chosen.includes(c)) continue;
      const md = minDist(c, chosen);
      if (md < minSep) continue;
      const s = md * (0.6 + 0.4 * c.centrality);
      if (s > score) {
        score = s;
        pick = c;
      }
    }
    if (!pick) {
      for (const c of cands) {
        if (chosen.includes(c)) continue;
        const md = minDist(c, chosen);
        if (md > score) {
          score = md;
          pick = c;
        }
      }
    }
    if (!pick) break;
    chosen.push(pick);
  }
  // Lloyd: move each depot to the candidate nearest its demand-weighted centroid
  for (let it = 0; it < 2 && seeds.length; it++) {
    const sums = chosen.map(() => ({ x: 0, z: 0, w: 0 }));
    for (const s of seeds) {
      let k = 0;
      let bd = Infinity;
      chosen.forEach((c, i) => {
        const d = (c.cx - s.cx) ** 2 + (c.cz - s.cz) ** 2;
        if (d < bd) {
          bd = d;
          k = i;
        }
      });
      sums[k].x += s.cx * s.demand;
      sums[k].z += s.cz * s.demand;
      sums[k].w += s.demand;
    }
    chosen.forEach((c, i) => {
      if (sums[i].w <= 0) return;
      const tx = sums[i].x / sums[i].w;
      const tz = sums[i].z / sums[i].w;
      let bestC = c;
      let bd = Math.hypot(c.cx - tx, c.cz - tz) * 0.8; // hysteresis
      for (const q of cands) {
        if (chosen.includes(q)) continue;
        if (landmass && landmass.of(q.cx, q.cz) !== landmass.of(c.cx, c.cz)) continue; // a depot stays on its island
        const d = Math.hypot(q.cx - tx, q.cz - tz);
        if (d >= bd) continue;
        if (minDist(q, chosen.filter((o) => o !== c)) < minSep) continue;
        bd = d;
        bestC = q;
      }
      chosen[i] = bestC;
    });
  }
  chosen.sort((a, b) => Math.hypot(a.cx - layout.centre.x, a.cz - layout.centre.z) - Math.hypot(b.cx - layout.centre.x, b.cz - layout.centre.z));
  for (const c of chosen) c.kind = 'depot';
  return chosen;
}

/** Turns the built depot blocks into depot / pad / charger records. */
export function assembleDepots(builds: { block: LayoutBlock; build: DepotBuild }[], groundY: number, terrain?: HeightField): { depots: DepotData[]; pads: PadData[]; chargers: ChargerData[] } {
  const depots: DepotData[] = [];
  const pads: PadData[] = [];
  const chargers: ChargerData[] = [];
  const gy = (x: number, z: number) => (terrain ? heightAt(terrain, x, z) : 0) + groundY;
  builds.forEach(({ block, build }, i) => {
    const id = `D${i + 1}`;
    const depot: DepotData = {
      id,
      name: `Depot ${id}`,
      kind: 'depot',
      zone: block.zone,
      districtId: block.districtId,
      rooftop: false,
      pos: { x: (build.apron.minX + build.apron.maxX) / 2, y: gy((build.apron.minX + build.apron.maxX) / 2, (build.apron.minZ + build.apron.maxZ) / 2), z: (build.apron.minZ + build.apron.maxZ) / 2 },
      buildingId: build.building.id,
      padIds: [],
      chargerIds: [],
      handoff: build.handoff.map((h) => ({ x: h.x, y: gy(h.x, h.z), z: h.z })),
      apron: { ...build.apron },
      catchmentShards: [],
    };
    const alongX = build.apron.maxX - build.apron.minX >= build.apron.maxZ - build.apron.minZ;
    build.pads.forEach((p, k) => {
      const padId = `PAD-${id}-${k + 1}`;
      pads.push({ id: padId, pos: { x: p.x, y: gy(p.x, p.z) + 0.1, z: p.z }, radius: 3, rooftop: false, depotId: id, enabled: true });
      depot.padIds.push(padId);
      const chId = `CHG-${id}-${k + 1}`;
      const away = alongX ? (p.z > build.building.cz ? 1 : -1) : p.x > build.building.cx ? 1 : -1;
      chargers.push({ id: chId, depotId: id, padId, pos: { x: alongX ? p.x : p.x + away * 4.6, y: gy(p.x, p.z) + 0.1, z: alongX ? p.z + away * 4.6 : p.z } });
      depot.chargerIds.push(chId);
    });
    depots.push(depot);
  });
  return { depots, pads, chargers };
}
