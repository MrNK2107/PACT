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

export function siteDepotBlocks(layout: CityLayout, seeds: ClusterSeed[], n: number, kind: DepotLayout = 'distributed'): LayoutBlock[] {
  const minSep = kind === 'micro' ? 250 : layout.size < 2500 ? 300 : 600;
  const excluded = new Set(['airport', 'water', 'hospital', 'stadium']);
  let cands: LayoutBlock[] = [];
  for (const tier of kind === 'micro' ? CAND_TIERS_MICRO : kind === 'single_hub' ? CAND_TIERS_HUB : CAND_TIERS) {
    cands = layout.blocks.filter((b) => !b.kind && !b.nearWater && !excluded.has(b.district) && (tier.kinds.length === 0 || tier.kinds.includes(b.district)) && fits(b, tier.w, tier.d, tier.maxArea));
    if (cands.length >= n) break;
  }
  if (!cands.length) cands = layout.blocks.filter((b) => !b.kind && !excluded.has(b.district));
  if (!cands.length) throw new Error('no depot candidates');
  const chosen: LayoutBlock[] = [];
  let best = cands[0];
  for (const c of cands) if (c.centrality > best.centrality) best = c;
  chosen.push(best);
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
