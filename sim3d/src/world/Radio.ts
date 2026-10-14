import { polygonShape, pointInShape } from './NoFly';
import type { RadioFileSpec } from '../scenario/types';
import type { BuildingData, CraneData, DistrictData, NoFlyShape, RadioSpec, RadioZone } from './types';

/**
 * Radio dead zones: regions where the radio range shrinks and packets are lost, e.g. in the shadow of
 * tall buildings or among cranes and tanks. Pure geometry and generation (no RNG, so the main
 * generator stream is untouched). The simulation applies the effect in `sim/Radio.ts`.
 *
 * A link is degraded when either endpoint lies inside an active zone below the zone's `maxY`.
 */

export interface RadioEffect {
  /** Multiplier on the radio range (1 = unaffected, 0 = dark). */
  rangeFactor: number;
  /** Extra packet-loss probability. */
  loss: number;
}

const CLEAR: RadioEffect = { rangeFactor: 1, loss: 0 };

/** Combined effect of every active zone containing (x, y, z): smallest range factor, losses combined. */
export function radioEffectAt(zones: readonly RadioZone[], x: number, y: number, z: number): RadioEffect {
  let factor = 1;
  let keep = 1;
  let hit = false;
  for (const zone of zones) {
    if (!zone.active || y > zone.maxY || !pointInShape(zone.shape, x, z)) continue;
    hit = true;
    if (zone.rangeFactor < factor) factor = zone.rangeFactor;
    keep *= 1 - zone.lossAdd;
  }
  return hit ? { rangeFactor: factor, loss: 1 - keep } : CLEAR;
}

/** Radio zone specs from files, with PRD ground {x, y} mapped onto world {x, z}. */
export function radioSpecsFrom(list: RadioFileSpec[]): RadioSpec[] {
  return list.map((n) => {
    const spec: RadioSpec = { id: n.id, name: n.name, rangeFactor: n.range_factor, loss: n.loss, maxY: n.max_alt_m, active: n.active };
    if (n.circle) spec.circle = { x: n.circle.x, z: n.circle.y, r: n.circle.r };
    if (n.box) spec.box = { minX: Math.min(n.box.x0, n.box.x1), maxX: Math.max(n.box.x0, n.box.x1), minZ: Math.min(n.box.y0, n.box.y1), maxZ: Math.max(n.box.y0, n.box.y1) };
    if (n.polygon) spec.polygon = n.polygon.map((p) => ({ x: p.x, z: p.y }));
    return spec;
  });
}

/** Builds a zone from a scenario / map spec (coordinates already in world x/z). */
export function radioZoneFromSpec(spec: RadioSpec, index: number, source: RadioZone['source'] = 'scenario'): RadioZone {
  let shape: NoFlyShape;
  if (spec.circle) shape = { type: 'circle', x: spec.circle.x, z: spec.circle.z, r: spec.circle.r };
  else if (spec.box) shape = { type: 'box', ...spec.box };
  else if (spec.polygon) shape = polygonShape(spec.polygon);
  else throw new Error(`radio zone [${index}] needs circle, box or polygon`);
  return {
    id: spec.id ?? `RAD-S${String(index + 1).padStart(2, '0')}`,
    name: spec.name ?? `Radio dead zone ${index + 1}`,
    shape,
    rangeFactor: spec.rangeFactor ?? 0,
    lossAdd: spec.loss ?? 0,
    maxY: spec.maxY ?? 150,
    active: spec.active ?? true,
    source,
  };
}

/**
 * Automatic dead zones: urban canyons (a cluster of tall buildings in a CBD / commercial district) and
 * metal clutter (cranes in industrial / port districts). Deterministic and independent of the RNG.
 */
export function generateRadioZones(districts: readonly DistrictData[], buildings: readonly BuildingData[], cranes: readonly CraneData[]): RadioZone[] {
  const zones: RadioZone[] = [];
  const inside = (d: DistrictData, x: number, z: number) => x >= d.minX && x <= d.maxX && z >= d.minZ && z <= d.maxZ;

  // urban canyons: districts ranked by how many tall buildings they hold
  const canyons: { d: DistrictData; tall: BuildingData[] }[] = [];
  for (const d of districts) {
    if (d.kind !== 'cbd' && d.kind !== 'commercial') continue;
    const tall = buildings.filter((b) => b.h >= 60 && inside(d, b.cx, b.cz));
    if (tall.length >= 3) canyons.push({ d, tall });
  }
  canyons.sort((a, b) => b.tall.length - a.tall.length || (a.d.id < b.d.id ? -1 : 1));
  for (const { d, tall } of canyons.slice(0, 3)) {
    const cx = tall.reduce((s, b) => s + b.cx, 0) / tall.length;
    const cz = tall.reduce((s, b) => s + b.cz, 0) / tall.length;
    const spread = Math.max(...tall.map((b) => Math.hypot(b.cx - cx, b.cz - cz)));
    const top = Math.max(...tall.map((b) => b.h));
    zones.push({
      id: `RAD-${String(zones.length + 1).padStart(2, '0')}`,
      name: `Urban canyon shadow (${d.name})`,
      shape: { type: 'circle', x: cx, z: cz, r: Math.max(80, Math.min(220, spread + 40)) },
      rangeFactor: 0.2,
      lossAdd: 0.3,
      maxY: Math.min(110, top * 0.9),
      active: true,
      source: 'auto',
    });
  }

  // metal clutter around cranes in industrial / port districts
  const clutter = districts.filter((d) => (d.kind === 'industrial' || d.kind === 'port') && cranes.some((c) => inside(d, c.x, c.z)));
  clutter.sort((a, b) => cranes.filter((c) => inside(b, c.x, c.z)).length - cranes.filter((c) => inside(a, c.x, c.z)).length || (a.id < b.id ? -1 : 1));
  for (const d of clutter.slice(0, 2)) {
    zones.push({
      id: `RAD-${String(zones.length + 1).padStart(2, '0')}`,
      name: `Industrial clutter (${d.name})`,
      shape: { type: 'circle', x: (d.minX + d.maxX) / 2, z: (d.minZ + d.maxZ) / 2, r: Math.max(80, Math.min(180, (Math.min(d.maxX - d.minX, d.maxZ - d.minZ) / 2) * 0.8)) },
      rangeFactor: 0.45,
      lossAdd: 0.15,
      maxY: 70,
      active: true,
      source: 'auto',
    });
  }
  return zones;
}
