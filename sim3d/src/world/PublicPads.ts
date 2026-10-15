import type { GroundSite } from './BuildContext';
import { inNoFly } from './NoFly';
import type { ChargerData, DepotData, NoFlyZone, PadData } from './types';

/**
 * Public charging pads: standalone pads outside any depot (no hand-off bays, no parcels), sited on
 * ground drop-site candidates. Selection is a deterministic maximin: each next pad is the candidate
 * farthest from every depot and previously chosen pad, so public pads fill the gaps in coverage.
 * No RNG is used.
 */
export interface PublicPadResult {
  pads: PadData[];
  chargers: ChargerData[];
  /** Candidate sites that became pads (the caller removes them from the drop-site pool). */
  used: GroundSite[];
}

const MIN_SEPARATION = 150;

export function sitePublicPads(n: number, candidates: readonly GroundSite[], depots: readonly DepotData[], noFly: readonly NoFlyZone[], groundY: number): PublicPadResult {
  const out: PublicPadResult = { pads: [], chargers: [], used: [] };
  const anchors: { x: number; z: number }[] = depots.map((d) => ({ x: d.pos.x, z: d.pos.z }));
  const nearApron = (x: number, z: number) => depots.some((d) => x > d.apron.minX - 15 && x < d.apron.maxX + 15 && z > d.apron.minZ - 15 && z < d.apron.maxZ + 15);
  const pool = candidates.filter((c) => !inNoFly(noFly, c.x, c.z, 3, false) && !nearApron(c.x, c.z));
  for (let i = 0; i < n; i++) {
    let best: GroundSite | null = null;
    let score = -Infinity;
    for (const c of pool) {
      if (out.used.includes(c)) continue;
      let md = Infinity;
      for (const a of anchors) md = Math.min(md, Math.hypot(a.x - c.x, a.z - c.z));
      if (md > score) {
        score = md;
        best = c;
      }
    }
    if (!best || score < MIN_SEPARATION) break;
    out.used.push(best);
    anchors.push({ x: best.x, z: best.z });
    const padId = `PAD-P${i + 1}`;
    out.pads.push({ id: padId, pos: { x: best.x, y: groundY + 0.1, z: best.z }, radius: 3, rooftop: false, depotId: '', enabled: true });
    out.chargers.push({ id: `CHG-P${i + 1}`, depotId: '', padId, pos: { x: best.x + 4.6, y: groundY + 0.1, z: best.z } });
  }
  return out;
}
