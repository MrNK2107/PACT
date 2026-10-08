import type { BuildContext } from './BuildContext';
import type { CityLayout } from './CityLayout';
import type { Rng } from './rng';
import type { DistrictKind, PropData, RoadKind, StreetlightData, VehicleRoute } from './types';

/**
 * Street furniture, street trees and ground traffic for every road / block the layout produced.
 * Per-district tree spacing and species, lights by road class, vehicles by road class.
 */

const VEH = ['#d8d8d4', '#2d3640', '#7d8791', '#9c3a35', '#355c8a', '#b8b49a', '#4c5a48', '#e3e3df', '#6b4a3a'];
const TRUCK = ['#e8e8e4', '#b9bcc0', '#2c5f8a', '#c8392f'];

const LIGHT_STEP: Record<RoadKind, number> = { motorway: 40, arterial: 35, collector: 45, local: 60, service: 0 };
const LIGHT_P: Record<RoadKind, number> = { motorway: 1, arterial: 1, collector: 0.9, local: 0.45, service: 0 };
const VEH_PER_M: Record<RoadKind, number> = { motorway: 1 / 80, arterial: 1 / 110, collector: 1 / 220, local: 1 / 450, service: 0 };

const TREE_SPACING: Partial<Record<DistrictKind, number>> = {
  cbd: 14,
  commercial: 16,
  mixed: 12,
  apartments: 10,
  townhouses: 11,
  houses: 14,
  suburb: 16,
  campus: 12,
  hospital: 16,
  waterfront: 12,
  park: 10,
  industrial: 24,
  logistics: 30,
};

export function generateStreetscape(layout: CityLayout, ctx: BuildContext, rng: Rng, opts: { coastal: (x: number, z: number) => boolean }): { streetlights: StreetlightData[]; vehicles: VehicleRoute[]; props: PropData[] } {
  const streetlights: StreetlightData[] = [];
  const vehicles: VehicleRoute[] = [];
  const props: PropData[] = [];

  // junction lookup per road centre-line
  const jx = new Map<string, number[]>();
  for (const j of layout.junctions) {
    const kEW = `EW:${j.z}`;
    const kNS = `NS:${j.x}`;
    (jx.get(kEW) ?? jx.set(kEW, []).get(kEW)!).push(j.x);
    (jx.get(kNS) ?? jx.set(kNS, []).get(kNS)!).push(j.z);
  }

  // ---- lights + traffic per road -----------------------------------------------------------------------
  let vn = 0;
  for (const r of layout.roads) {
    const len = r.b - r.a;
    const crossings = jx.get(`${r.dir}:${r.c}`) ?? [];
    const onBridge = (t: number) => !!r.bridges?.some((b) => t > b.a && t < b.b);
    const step = LIGHT_STEP[r.kind];
    if (step > 0) {
      let side = 1;
      for (let t = r.a + 12; t < r.b - 8; t += step) {
        side = -side;
        if (!rng.chance(LIGHT_P[r.kind])) continue;
        if (crossings.some((c) => Math.abs(c - t) < 9)) continue;
        if (onBridge(t)) continue;
        const off = side * (r.width / 2 + 1);
        const x = r.dir === 'NS' ? r.c + off : t;
        const z = r.dir === 'NS' ? t : r.c + off;
        const rot = r.dir === 'NS' ? (side > 0 ? Math.PI : 0) : side > 0 ? Math.PI / 2 : -Math.PI / 2;
        streetlights.push({ x, z, rot });
        if (r.kind === 'motorway' && side > 0) {
          // median lights too
          streetlights.push({ x: r.dir === 'NS' ? r.c : t, z: r.dir === 'NS' ? t : r.c, rot: rot + Math.PI });
        }
      }
    }
    const n = Math.round(len * VEH_PER_M[r.kind] * (r.kind === 'local' && len < 120 ? 0 : 1));
    for (let i = 0; i < n; i++) {
      const lane: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const roll = rng.next();
      const industrial = false;
      const type: VehicleRoute['type'] = r.kind === 'motorway' && roll < 0.25 ? 'truck' : r.kind === 'arterial' && roll < 0.08 ? 'bus' : roll < 0.12 ? 'van' : roll < 0.16 && r.kind !== 'local' ? 'truck' : 'car';
      void industrial;
      const laneCount = Math.max(1, Math.floor(r.lanes / 2));
      const laneIdx = rng.int(0, laneCount - 1);
      const offset = (laneIdx + 0.5) * 3.2 + (r.kind === 'motorway' ? 1.5 : 0);
      vehicles.push({
        id: `V-${String(++vn).padStart(5, '0')}`,
        type,
        roadId: r.id,
        dir: r.dir,
        c: r.c,
        a: r.a,
        b: r.b,
        lane,
        laneOffset: r.dir === 'EW' ? lane * offset : -lane * offset,
        speed: (r.kind === 'motorway' ? rng.range(22, 30) : r.kind === 'arterial' ? rng.range(10, 14) : rng.range(6, 10)) * (type === 'truck' ? 0.85 : 1),
        phase: rng.range(0, len),
        color: type === 'truck' ? rng.pick(TRUCK) : type === 'bus' ? '#d9b43a' : rng.pick(VEH),
      });
    }
    // bus stops on arterials / collectors, billboards on arterials
    if (r.kind === 'arterial' || r.kind === 'collector') {
      for (let t = r.a + 60; t < r.b - 40; t += rng.range(160, 260)) {
        if (onBridge(t) || crossings.some((c) => Math.abs(c - t) < 14)) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        const off = side * (r.width / 2 + 2.2);
        props.push({ type: 'busstop', x: r.dir === 'NS' ? r.c + off : t, z: r.dir === 'NS' ? t : r.c + off, rot: r.dir === 'NS' ? Math.PI / 2 : 0, sx: 4, sz: 1.4 });
      }
    }
    if (r.kind === 'arterial' || r.kind === 'motorway') {
      for (let t = r.a + 120; t < r.b - 60; t += rng.range(300, 600)) {
        if (onBridge(t)) continue;
        const side = rng.chance(0.5) ? 1 : -1;
        const off = side * (r.width / 2 + (r.kind === 'motorway' ? 16 : 5));
        props.push({ type: 'billboard', x: r.dir === 'NS' ? r.c + off : t, z: r.dir === 'NS' ? t : r.c + off, rot: r.dir === 'NS' ? Math.PI / 2 : 0, sx: 9, sz: 0.4 });
      }
    }
  }

  // ---- street trees along block edges ------------------------------------------------------------------
  for (const b of layout.blocks) {
    const sp = TREE_SPACING[b.district];
    if (!sp) continue;
    if (['gasstation', 'airport', 'quay', 'containeryard', 'tanks', 'substation', 'solarfarm', 'depot', 'stadium'].includes(b.kind)) continue;
    const coastal = opts.coastal(b.cx, b.cz);
    const species = coastal && rng.chance(0.5) ? 'palm' : undefined;
    const edges: [number, number, number, number, number][] = [
      [b.cx - b.w / 2, b.cz - b.d / 2 + 1.4, b.cx + b.w / 2, b.cz - b.d / 2 + 1.4, b.streets.n],
      [b.cx - b.w / 2, b.cz + b.d / 2 - 1.4, b.cx + b.w / 2, b.cz + b.d / 2 - 1.4, b.streets.s],
      [b.cx - b.w / 2 + 1.4, b.cz - b.d / 2, b.cx - b.w / 2 + 1.4, b.cz + b.d / 2, b.streets.w],
      [b.cx + b.w / 2 - 1.4, b.cz - b.d / 2, b.cx + b.w / 2 - 1.4, b.cz + b.d / 2, b.streets.e],
    ];
    for (const [x0, z0, x1, z1, sw] of edges) {
      if (sw <= 0) continue;
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.floor(len / sp);
      for (let k = 0; k < n; k++) {
        if (!rng.chance(0.8)) continue;
        const u = (k + 0.5) / n + rng.range(-0.15, 0.15) / n;
        ctx.addTree(x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, 5, 9, 0.1, species);
      }
    }
  }

  return { streetlights, vehicles, props };
}
