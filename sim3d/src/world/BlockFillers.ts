import { BuildContext, FLOOR_H, type BuildingSpec } from './BuildContext';
import type { CityLayout, LayoutBlock } from './CityLayout';
import { polygonShape } from './NoFly';
import type { Noise2D } from './noise';
import { jitter, type Palette } from './palettes';
import type { Rng } from './rng';
import type { BlockData, BuildingData, ContainerStack, CraneData, DistrictKind, LoadingBay, NoFlyZone, ParkingSpace, PropData, UtilityStructure } from './types';

/**
 * Block fillers: turn a LayoutBlock (a rectangle between streets) into buildings, lots, props,
 * trees, drop-point candidates and local no-fly zones. Variety comes from
 *   - weighted, district-dependent kind selection modulated by a slow noise field,
 *   - jittered lot subdivision with skipped / merged lots and random setbacks,
 *   - a height noise field plus centrality, quantised to floors,
 *   - per-district palettes with per-building jitter.
 */

export interface FillEnv {
  rng: Rng;
  noise: Noise2D;
  kindNoise: Noise2D;
  skyline: Noise2D;
  layout: CityLayout;
  palettes: Map<string, Palette>;
  padsPerDepot: number;
  /** Per depot block pad counts (hub-and-spoke / micro layouts); absent blocks use `padsPerDepot`. */
  depotPads?: Map<string, number>;
  /** Tall-building height caps (legacy: 8 km maps and up). */
  tall: boolean;
  /** districtId -> kind -> blocks already assigned (damps repetition inside a district). */
  kindCounts: Map<string, Map<string, number>>;
}

export interface FillOut {
  blocks: BlockData[];
  props: PropData[];
  parking: ParkingSpace[];
  containers: ContainerStack[];
  loadingBays: LoadingBay[];
  cranes: CraneData[];
  utilities: UtilityStructure[];
  noFly: NoFlyZone[];
  /** Blocks that were turned into depots (filled by `fillDepot`). */
  depotBlocks: LayoutBlock[];
}

type Filler = (ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut) => void;

// -------------------------------------------------------------------------------------------------
// Kind selection
// -------------------------------------------------------------------------------------------------

type Weighted = [string, number][];

const KIND_WEIGHTS: Record<DistrictKind, Weighted> = {
  cbd: [['tower', 5], ['towerpair', 2], ['officeblock', 3], ['hotel', 1.2], ['plaza', 1], ['parkinggarage', 0.8], ['mall', 0.5], ['civic', 0.4], ['construction', 0.5]],
  commercial: [['officeblock', 4], ['tower', 2], ['officemid', 3], ['hotel', 1], ['mall', 0.8], ['strip', 1.5], ['plaza', 0.8], ['parkinggarage', 1], ['supermarket', 0.6], ['construction', 0.4]],
  mixed: [['perimeter', 5], ['slabs', 2], ['officemid', 2], ['strip', 1.2], ['plaza', 0.6], ['supermarket', 0.6], ['school', 0.5], ['pocketpark', 0.6], ['church', 0.3], ['parkinggarage', 0.4], ['construction', 0.3]],
  apartments: [['slabs', 5], ['perimeter', 3], ['towerspark', 2], ['pocketpark', 0.8], ['school', 0.6], ['supermarket', 0.6], ['strip', 0.6], ['church', 0.2], ['sportsfield', 0.3]],
  townhouses: [['rows', 6], ['houses', 1.5], ['duplex', 1.5], ['pocketpark', 0.8], ['school', 0.5], ['church', 0.4], ['cornershop', 0.8], ['slabs', 0.5]],
  houses: [['houses', 6], ['bighouses', 1.5], ['duplex', 2], ['pocketpark', 0.7], ['school', 0.4], ['church', 0.3], ['cornershop', 0.6], ['gasstation', 0.25], ['supermarket', 0.25], ['sportsfield', 0.3]],
  suburb: [['bighouses', 5], ['houses', 3], ['pocketpark', 0.6], ['church', 0.3], ['sportsfield', 0.5], ['solarfarm', 0.4], ['paddock', 1], ['gasstation', 0.2], ['cornershop', 0.3]],
  industrial: [['warehouses', 5], ['factory', 3], ['sheds', 2], ['tanks', 1], ['truckdepot', 1.2], ['substation', 0.5], ['watertower', 0.4], ['silos', 0.5], ['construction', 0.3]],
  logistics: [['warehouses', 5], ['distribution', 2], ['containeryard', 1.5], ['truckdepot', 1.5], ['sheds', 1], ['factory', 0.8]],
  port: [['containeryard', 4], ['quay', 2], ['warehouses', 3], ['tanks', 1.5], ['silos', 1], ['truckdepot', 0.8]],
  park: [['park', 1]],
  campus: [['campus', 1]],
  hospital: [['hospital', 1]],
  stadium: [['stadium', 1]],
  airport: [['airport', 1]],
  cemetery: [['cemetery', 1]],
  waterfront: [['promenade', 3], ['marina', 1.5], ['perimeter', 1.5], ['slabs', 1], ['hotel', 0.6], ['pocketpark', 0.8]],
  farmland: [['fields', 5], ['farmstead', 2], ['paddock', 2], ['barns', 1.2], ['solarfarm', 0.4]],
  water: [],
};

/** Minimum block footprint each kind needs (x, z, either orientation). */
const MIN_SIZE: Record<string, [number, number]> = {
  tower: [52, 52],
  towerpair: [70, 60],
  officeblock: [50, 44],
  hotel: [46, 36],
  mall: [90, 70],
  parkinggarage: [40, 34],
  civic: [60, 50],
  perimeter: [48, 44],
  slabs: [48, 40],
  towerspark: [70, 60],
  school: [70, 55],
  supermarket: [60, 50],
  gasstation: [34, 30],
  warehouses: [60, 50],
  factory: [80, 60],
  distribution: [100, 70],
  containeryard: [90, 70],
  truckdepot: [60, 50],
  quay: [80, 60],
  sportsfield: [80, 55],
  solarfarm: [70, 60],
  tanks: [50, 50],
  silos: [40, 40],
  stadium: [160, 130],
  hospital: [110, 90],
  campus: [100, 80],
  marina: [50, 40],
  construction: [40, 36],
};

export function chooseBlockKind(b: LayoutBlock, env: FillEnv): string {
  if (b.kind) return b.kind;
  const weights = KIND_WEIGHTS[b.district];
  if (!weights.length) return 'empty';
  const rng = env.rng;
  const lo = Math.min(b.w, b.d);
  const hi = Math.max(b.w, b.d);
  const corner = (b.streets.n >= 12 || b.streets.s >= 12) && (b.streets.e >= 12 || b.streets.w >= 12);
  const arterial = Math.max(b.streets.n, b.streets.s, b.streets.e, b.streets.w) >= 18;
  const field = env.kindNoise.fbm(b.cx, b.cz, 650, 2); // 0..1 drifts slowly across the district
  const list: Weighted = [];
  for (const [k, w0] of weights) {
    const ms = MIN_SIZE[k];
    if (ms && !((lo >= ms[1] && hi >= ms[0]) || (lo >= ms[0] && hi >= ms[1]))) continue;
    let w = w0;
    // the slow field boosts the first half of the list in one area and the second half elsewhere
    const idx = weights.findIndex((e) => e[0] === k) / Math.max(1, weights.length - 1);
    w *= 0.6 + 0.8 * (1 - Math.abs(field - idx));
    if (corner && ['cornershop', 'gasstation', 'strip', 'plaza', 'church'].includes(k)) w *= 3;
    if (arterial && ['strip', 'officemid', 'supermarket', 'mall', 'hotel', 'gasstation'].includes(k)) w *= 2;
    if (b.nearWater && ['promenade', 'marina', 'hotel'].includes(k)) w *= 2.5;
    if (!b.nearWater && (k === 'promenade' || k === 'marina' || k === 'quay')) w *= 0.15;
    if (k === 'tower' || k === 'towerpair') w *= 0.4 + 1.6 * env.skyline.fbm(b.cx, b.cz, 1400, 2);
    // the more often a kind already appears in this district, the less likely it is picked again
    const used = env.kindCounts.get(b.districtId)?.get(k) ?? 0;
    w /= 1 + 0.45 * used;
    list.push([k, w]);
  }
  if (!list.length) return b.district === 'park' ? 'park' : 'pocketpark';
  let total = 0;
  for (const [, w] of list) total += w;
  let r = rng.next() * total;
  for (const [k, w] of list) {
    r -= w;
    if (r <= 0) return k;
  }
  return list[list.length - 1][0];
}

// -------------------------------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------------------------------

interface Lot {
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Unit vector from lot centre towards its street frontage. */
  fx: number;
  fz: number;
  frontage: number;
  depth: number;
  skipped: boolean;
}

function lots(b: LayoutBlock, rng: Rng, fmin: number, fmax: number, rows: 1 | 2, skip = 0.12): Lot[] {
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const D = alongX ? b.d : b.w;
  const depth = rows === 2 ? D / 2 : D;
  const out: Lot[] = [];
  let t = -L / 2 + rng.range(0, 2);
  while (t < L / 2 - fmin * 0.6) {
    let f = Math.min(rng.range(fmin, fmax), L / 2 - t);
    if (rng.chance(0.08)) f = Math.min(f * 1.8, L / 2 - t);
    if (f < fmin * 0.6) break;
    for (const row of rows === 2 ? [-1, 1] : [1]) {
      const along = t + f / 2;
      const across = rows === 2 ? (row * depth) / 2 : 0;
      const sgn = rows === 2 ? row : 1;
      out.push({
        cx: alongX ? b.cx + along : b.cx + across,
        cz: alongX ? b.cz + across : b.cz + along,
        w: alongX ? f : depth,
        d: alongX ? depth : f,
        fx: alongX ? 0 : sgn,
        fz: alongX ? sgn : 0,
        frontage: f,
        depth,
        skipped: rng.chance(skip),
      });
    }
    t += f;
  }
  return out;
}

function pal(b: LayoutBlock, env: FillEnv): Palette {
  return env.palettes.get(b.districtId)!;
}

function facade(p: Palette, rng: Rng, glassBias = 0): { color: string; material: BuildingData['material'] } {
  const r = rng.next();
  if (r < p.glassShare + glassBias) return { color: jitter(rng.pick(p.glass), rng), material: 'glass' };
  if (r < p.glassShare + glassBias + p.brick) return { color: jitter(rng.pick(['#a8654d', '#9a5a45', '#b3705a', '#8f5f4e', '#c08a6a']), rng), material: rng.chance(0.8) ? 'brick' : 'stone' };
  const color = jitter(rng.pick(p.facade), rng);
  return { color, material: rng.pick(['plaster', 'plaster', 'concrete', 'panel']) as BuildingData['material'] };
}

/** Height multiplier field: slow noise x centrality (dense kinds only). */
function hMult(b: LayoutBlock, env: FillEnv, dense: boolean): number {
  const n = 0.7 + 0.6 * env.noise.fbm(b.cx, b.cz, 900, 3);
  const c = dense ? 1 + 1.4 * b.centrality * b.centrality : 1;
  const outlier = env.rng.chance(0.04) ? 1.6 : 1;
  return n * c * outlier;
}

function floors(base: number, mult: number, min = 1, max = 60): number {
  return Math.max(min, Math.min(max, Math.round(base * mult)));
}

function addBlock(b: LayoutBlock, out: FillOut, kind: string, surface: BlockData['surface'], lotColor: string): BlockData {
  const bd: BlockData = { id: b.id, zone: b.zone, districtId: b.districtId, kind, cx: b.cx, cz: b.cz, w: b.w, d: b.d, lotColor, surface };
  out.blocks.push(bd);
  return bd;
}

function spec(b: LayoutBlock, s: Omit<BuildingSpec, 'zone' | 'blockId'>): BuildingSpec {
  return { ...s, zone: b.zone, blockId: b.id };
}

function ground(ctx: BuildContext, b: LayoutBlock, x: number, z: number, name: string, buildingId?: string): void {
  if (!ctx.clear(x, z, 5)) return;
  ctx.groundSites.push({ blockId: b.id, districtId: b.districtId, zone: b.zone, x, z, name, buildingId });
  ctx.keepout(x, z, 6);
}

function roof(ctx: BuildContext, b: LayoutBlock, bld: BuildingData, name: string, at?: { x: number; z: number }): void {
  ctx.roofSites.push({ buildingId: bld.id, blockId: b.id, districtId: b.districtId, zone: b.zone, x: at?.x ?? bld.cx, y: bld.baseY + bld.h, z: at?.z ?? bld.cz, name });
}

function treesIn(ctx: BuildContext, rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number, n: number, hmin = 5, hmax = 9, conifer = 0.15, species?: 'palm' | 'cypress'): void {
  for (let i = 0; i < n; i++) ctx.addTree(rng.range(minX, maxX), rng.range(minZ, maxZ), hmin, hmax, conifer, species);
}

function parkingLot(out: FillOut, rng: Rng, minX: number, maxX: number, minZ: number, maxZ: number, alongX = true): void {
  const w = maxX - minX;
  const d = maxZ - minZ;
  if (w < 12 || d < 12) return;
  if (alongX) {
    // rows of bays along X, double rows with 6 m aisles along Z
    for (let z = minZ + 2.6; z + 10.4 <= maxZ; z += 16.4) {
      for (let x = minX + 1.3; x + 2.6 <= maxX; x += 2.6) {
        if (rng.chance(0.08)) continue;
        out.parking.push({ x, z: z + 2.6, rot: 0, w: 2.6, d: 5.2 });
        out.parking.push({ x, z: z + 7.8, rot: 0, w: 2.6, d: 5.2 });
      }
    }
  } else {
    for (let x = minX + 2.6; x + 10.4 <= maxX; x += 16.4) {
      for (let z = minZ + 1.3; z + 2.6 <= maxZ; z += 2.6) {
        if (rng.chance(0.08)) continue;
        out.parking.push({ x: x + 2.6, z, rot: Math.PI / 2, w: 2.6, d: 5.2 });
        out.parking.push({ x: x + 7.8, z, rot: Math.PI / 2, w: 2.6, d: 5.2 });
      }
    }
  }
}

function fence(out: FillOut, minX: number, maxX: number, minZ: number, maxZ: number, type: PropData['type'] = 'fence'): void {
  out.props.push({ type, x: (minX + maxX) / 2, z: minZ, rot: 0, sx: maxX - minX, sz: 0.2 });
  out.props.push({ type, x: (minX + maxX) / 2, z: maxZ, rot: 0, sx: maxX - minX, sz: 0.2 });
  out.props.push({ type, x: minX, z: (minZ + maxZ) / 2, rot: Math.PI / 2, sx: maxZ - minZ, sz: 0.2 });
  out.props.push({ type, x: maxX, z: (minZ + maxZ) / 2, rot: Math.PI / 2, sx: maxZ - minZ, sz: 0.2 });
}

function bays(out: FillOut, bld: BuildingData, side: 'n' | 's' | 'e' | 'w', n: number): void {
  const alongX = side === 'n' || side === 's';
  const len = alongX ? bld.w : bld.d;
  const step = (len - 8) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const t = -(len - 8) / 2 + i * step;
    const x = alongX ? bld.cx + t : side === 'e' ? bld.cx + bld.w / 2 : bld.cx - bld.w / 2;
    const z = alongX ? (side === 's' ? bld.cz + bld.d / 2 : bld.cz - bld.d / 2) : bld.cz + t;
    out.loadingBays.push({ id: `LB-${out.loadingBays.length + 1}`, x, z, rot: side === 's' ? 0 : side === 'n' ? Math.PI : side === 'e' ? -Math.PI / 2 : Math.PI / 2, buildingId: bld.id });
  }
}

function rect(b: LayoutBlock) {
  return { minX: b.cx - b.w / 2, maxX: b.cx + b.w / 2, minZ: b.cz - b.d / 2, maxZ: b.cz + b.d / 2 };
}

/** Which block edge faces the widest street (for orienting fronts / docks). */
function frontSide(b: LayoutBlock): 'n' | 's' | 'e' | 'w' {
  const s = b.streets;
  let best: 'n' | 's' | 'e' | 'w' = 's';
  let bw = -1;
  for (const k of ['n', 's', 'e', 'w'] as const) {
    if (s[k] > bw) {
      bw = s[k];
      best = k;
    }
  }
  return best;
}

// -------------------------------------------------------------------------------------------------
// Residential fillers
// -------------------------------------------------------------------------------------------------

function fillHouses(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut, big = false): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, big ? 'bighouses' : 'houses', 'lawn', p.lawn);
  const rows: 1 | 2 = Math.min(b.w, b.d) >= 44 ? 2 : 1;
  const L = big ? lots(b, rng, 22, 32, rows, 0.1) : lots(b, rng, 12, 19, rows, 0.14);
  let n = 0;
  for (const lot of L) {
    if (lot.skipped) {
      treesIn(ctx, rng, lot.cx - lot.w / 2 + 2, lot.cx + lot.w / 2 - 2, lot.cz - lot.d / 2 + 2, lot.cz + lot.d / 2 - 2, 2, 5, 9);
      if (rng.chance(0.5)) ground(ctx, b, lot.cx, lot.cz, `Garden drop — ${b.id}`);
      continue;
    }
    const setback = rng.range(3, 6);
    const hw = Math.min(lot.frontage - 3, big ? rng.range(11, 14) : rng.range(7.5, 10.5));
    const hd = Math.min(lot.depth - setback - 4, big ? rng.range(9, 13) : rng.range(7, 10));
    if (hw < 5 || hd < 5) continue;
    // house sits `setback` from the frontage
    const cx = lot.cx + lot.fx * (lot.depth / 2 - setback - hd / 2);
    const cz = lot.cz + lot.fz * (lot.depth / 2 - setback - hd / 2);
    const storeys = big ? (rng.chance(0.7) ? 2 : 1) : rng.chance(0.55) ? 2 : 1;
    const f = facade(p, rng);
    const roofKind = rng.chance(0.55) ? 'gable' : rng.chance(0.6) ? 'hip' : 'flat';
    const w = lot.fx ? hd : hw;
    const d = lot.fx ? hw : hd;
    ctx.addBuilding(spec(b, { name: `${big ? 'Villa' : 'House'} ${b.id}-${++n}`, kind: 'house', cx: cx + rng.range(-0.6, 0.6), cz: cz + rng.range(-0.6, 0.6), w, d, h: storeys * 3 + rng.range(-0.2, 0.6), roof: roofKind, color: jitter(rng.pick(p.roof), rng), material: f.material === 'glass' ? 'plaster' : f.material, equipment: roofKind === 'flat' ? 1 : 0, solar: roofKind === 'flat' && rng.chance(0.3) }));
    if (rng.chance(big ? 0.7 : 0.35)) {
      // garage beside the house on the street side
      const gx = cx + (lot.fx ? 0 : (rng.chance(0.5) ? 1 : -1) * (hw / 2 + 3.2));
      const gz = cz + (lot.fz ? 0 : (rng.chance(0.5) ? 1 : -1) * (hd / 2 + 3.2));
      const ox = lot.fx ? lot.fx * (hd / 2 + 3.2) : 0;
      const oz = lot.fz ? lot.fz * (hd / 2 + 3.2) : 0;
      void ox;
      void oz;
      if (ctx.clear(gx, gz, 3)) ctx.addBuilding(spec(b, { name: `Garage ${b.id}-${n}`, kind: 'garage', cx: gx, cz: gz, w: 5.5, d: 6, h: 2.8, roof: rng.chance(0.5) ? 'gable' : 'flat', color: jitter(rng.pick(p.roof), rng), material: 'plaster' }));
    }
    // back garden
    const bx = lot.cx - lot.fx * (lot.depth / 2 - 4);
    const bz = lot.cz - lot.fz * (lot.depth / 2 - 4);
    if (rng.chance(0.75)) ctx.addTree(bx + rng.range(-lot.frontage / 2 + 2, lot.frontage / 2 - 2) * (lot.fz ? 1 : 0) + rng.range(-2, 2), bz + rng.range(-lot.frontage / 2 + 2, lot.frontage / 2 - 2) * (lot.fx ? 1 : 0), 5, 10);
    if (big && rng.chance(0.25)) out.props.push({ type: 'pool', x: bx, z: bz, rot: 0, sx: 7, sz: 4 });
    if (rng.chance(0.4)) out.props.push({ type: 'hedge', x: lot.cx + lot.fx * (lot.depth / 2 - 0.6), z: lot.cz + lot.fz * (lot.depth / 2 - 0.6), rot: lot.fx ? Math.PI / 2 : 0, sx: lot.frontage - 1, sz: 0.6 });
  }
  if (rng.chance(0.35)) ground(ctx, b, b.cx + rng.range(-4, 4), b.cz + rng.range(-4, 4), `Community drop — ${b.id}`);
}

function fillDuplex(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'duplex', 'lawn', p.lawn);
  const rows: 1 | 2 = Math.min(b.w, b.d) >= 40 ? 2 : 1;
  let n = 0;
  for (const lot of lots(b, rng, 16, 22, rows, 0.1)) {
    if (lot.skipped) continue;
    const setback = rng.range(3, 5);
    const hw = Math.min(lot.frontage - 2.5, 13);
    const hd = Math.min(lot.depth - setback - 4, 9);
    if (hw < 8 || hd < 6) continue;
    const cx = lot.cx + lot.fx * (lot.depth / 2 - setback - hd / 2);
    const cz = lot.cz + lot.fz * (lot.depth / 2 - setback - hd / 2);
    const f = facade(p, rng);
    ctx.addBuilding(spec(b, { name: `Duplex ${b.id}-${++n}`, kind: 'house', cx, cz, w: lot.fx ? hd : hw, d: lot.fx ? hw : hd, h: 6.2, roof: rng.chance(0.6) ? 'gable' : 'hip', color: jitter(rng.pick(p.roof), rng), material: f.material === 'glass' ? 'brick' : f.material }));
    if (rng.chance(0.6)) ctx.addTree(lot.cx - lot.fx * (lot.depth / 2 - 3), lot.cz - lot.fz * (lot.depth / 2 - 3), 5, 9);
  }
  if (rng.chance(0.3)) ground(ctx, b, b.cx, b.cz, `Community drop — ${b.id}`);
}

function fillRows(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'rows', 'lawn', p.lawn);
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const D = alongX ? b.d : b.w;
  const depth = Math.min(11, D / 2 - 4);
  if (depth < 7) return fillHouses(ctx, b, env, out);
  const storeys = rng.chance(0.6) ? 3 : 2;
  const roofKind = rng.chance(0.7) ? 'gable' : 'flat';
  for (const side of [-1, 1]) {
    // a terrace is a run of 4–9 attached units with occasional breaks
    let t = -L / 2 + 2;
    let unit = 0;
    while (t < L / 2 - 5) {
      const run = rng.int(4, 9);
      const f0 = rng.range(5.8, 7.4);
      const color = jitter(rng.pick(p.facade), rng);
      const roofColor = jitter(rng.pick(p.roof), rng);
      const mat: BuildingData['material'] = rng.chance(p.brick + 0.2) ? 'brick' : 'plaster';
      const h = storeys * 3.1 + rng.range(-0.3, 0.5);
      for (let k = 0; k < run && t < L / 2 - 4; k++) {
        const f = Math.min(f0, L / 2 - 2 - t);
        if (f < 4) break;
        const along = t + f / 2;
        const across = side * (D / 2 - 3 - depth / 2);
        const cx = alongX ? b.cx + along : b.cx + across;
        const cz = alongX ? b.cz + across : b.cz + along;
        ctx.addBuilding(spec(b, { name: `Terrace ${b.id}-${++unit}`, kind: 'townhouse', cx, cz, w: alongX ? f + 0.05 : depth, d: alongX ? depth : f + 0.05, h: h + (k % 3 === 0 ? rng.range(-0.3, 0.3) : 0), roof: roofKind, color: roofColor, material: mat }));
        t += f;
      }
      t += rng.chance(0.5) ? rng.range(3, 7) : 0;
      void color;
    }
    // back gardens
    treesIn(ctx, rng, alongX ? b.cx - L / 2 + 3 : b.cx + side * (D / 2 - 3 - depth - 1.5) - 1, alongX ? b.cx + L / 2 - 3 : b.cx + side * (D / 2 - 3 - depth - 1.5) + 1, alongX ? b.cz + side * (D / 2 - 3 - depth - 1.5) - 1 : b.cz - L / 2 + 3, alongX ? b.cz + side * (D / 2 - 3 - depth - 1.5) + 1 : b.cz + L / 2 - 3, Math.round(L / 14), 4, 8);
  }
  if (rng.chance(0.3)) ground(ctx, b, b.cx, b.cz, `Mews drop — ${b.id}`);
}

function fillSlabs(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'slabs', 'lawn', p.lawn);
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const D = alongX ? b.d : b.w;
  const depth = rng.range(11, 13.5);
  const nSlabs = Math.max(1, Math.min(4, Math.floor((D - 6) / (depth + rng.range(14, 22)))));
  const pitch = (D - 6) / nSlabs;
  const mult = hMult(b, env, true);
  let padDone = false;
  for (let i = 0; i < nSlabs; i++) {
    const across = -D / 2 + 3 + pitch * (i + 0.5);
    const len = Math.min(L - 8, rng.range(0.55, 0.9) * L);
    const along = rng.range(-(L - 8 - len) / 2, (L - 8 - len) / 2);
    const fl = floors(rng.range(5, 10), mult, 3, 18);
    const f = facade(p, rng);
    const solid = !padDone && fl <= 12 && rng.chance(0.6);
    const bld = ctx.addBuilding(spec(b, { name: `Apartment Block ${b.id}-${i + 1}`, kind: 'slab', cx: alongX ? b.cx + along : b.cx + across, cz: alongX ? b.cz + across : b.cz + along, w: alongX ? len : depth, d: alongX ? depth : len, h: fl * FLOOR_H, color: f.color, material: f.material, balconies: rng.chance(0.6), equipment: solid ? 1 : 2, solidTop: solid, keepout: solid ? { x: alongX ? b.cx + along : b.cx + across, z: alongX ? b.cz + across : b.cz + along, r: 4 } : undefined, solar: rng.chance(0.3) }));
    if (solid) {
      roof(ctx, b, bld, `Rooftop drop — ${bld.name}`);
      padDone = true;
    }
  }
  treesIn(ctx, rng, b.cx - b.w / 2 + 3, b.cx + b.w / 2 - 3, b.cz - b.d / 2 + 3, b.cz + b.d / 2 - 3, Math.round((b.w * b.d) / 900), 5, 10);
  if (rng.chance(0.5)) out.props.push({ type: 'playground', x: b.cx + rng.range(-b.w / 4, b.w / 4), z: b.cz + rng.range(-b.d / 4, b.d / 4), rot: 0, sx: 10, sz: 8 });
  const r = rect(b);
  if (rng.chance(0.6)) parkingLot(out, rng, r.minX + 2, Math.min(r.maxX - 2, r.minX + 30), r.maxZ - 13, r.maxZ - 1);
  ground(ctx, b, b.cx + rng.range(-6, 6), b.cz + rng.range(-6, 6), `Courtyard drop — ${b.id}`);
}

function fillPerimeter(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut, tall = false): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, tall ? 'officeblock' : 'perimeter', tall ? 'paving' : 'lawn', tall ? p.paving : p.lawn);
  const depth = Math.min(rng.range(12, 15), Math.min(b.w, b.d) / 2 - 6);
  if (depth < 8) return fillSlabs(ctx, b, env, out);
  const r = rect(b);
  const mult = hMult(b, env, true);
  let padDone = false;
  let n = 0;
  const edges: { x0: number; z0: number; x1: number; z1: number; alongX: boolean }[] = [
    { x0: r.minX, z0: r.minZ, x1: r.maxX, z1: r.minZ + depth, alongX: true },
    { x0: r.minX, z0: r.maxZ - depth, x1: r.maxX, z1: r.maxZ, alongX: true },
    { x0: r.minX, z0: r.minZ + depth, x1: r.minX + depth, z1: r.maxZ - depth, alongX: false },
    { x0: r.maxX - depth, z0: r.minZ + depth, x1: r.maxX, z1: r.maxZ - depth, alongX: false },
  ];
  for (const e of edges) {
    const len = e.alongX ? e.x1 - e.x0 : e.z1 - e.z0;
    if (len < 10) continue;
    // split the edge into 1–4 pieces of differing heights / colours
    let t = 0;
    const pieces = Math.max(1, Math.min(4, Math.round(len / rng.range(18, 32))));
    for (let k = 0; k < pieces; k++) {
      const f = k === pieces - 1 ? len - t : Math.min(len - t, rng.range(len / pieces / 1.4, (len / pieces) * 1.4));
      if (f < 6) break;
      const gap = rng.chance(0.12) && k > 0 ? 3 : 0;
      const fl = floors(tall ? rng.range(7, 13) : rng.range(4, 8), mult, 2, tall ? 22 : 12);
      const fc = facade(p, rng, tall ? 0.25 : 0);
      const cx = e.alongX ? e.x0 + t + gap + (f - gap) / 2 : (e.x0 + e.x1) / 2;
      const cz = e.alongX ? (e.z0 + e.z1) / 2 : e.z0 + t + gap + (f - gap) / 2;
      const gable = !tall && rng.chance(0.35);
      const solid = !padDone && !gable && fl <= 10 && rng.chance(0.4) && f - gap >= 12;
      const bld = ctx.addBuilding(spec(b, { name: `${tall ? 'Office' : 'Block'} ${b.id}-${++n}`, kind: tall ? 'office' : 'apartment', cx, cz, w: e.alongX ? f - gap : depth, d: e.alongX ? depth : f - gap, h: fl * FLOOR_H, roof: gable ? 'gable' : 'flat', color: gable ? jitter(rng.pick(p.roof), rng) : fc.color, material: fc.material, balconies: !tall && rng.chance(0.4), equipment: solid ? 1 : 2, solidTop: solid, keepout: solid ? { x: cx, z: cz, r: 4 } : undefined }));
      if (solid) {
        roof(ctx, b, bld, `Rooftop drop — ${bld.name}`);
        padDone = true;
      }
      t += f;
    }
  }
  // courtyard
  const cw = b.w - 2 * depth - 4;
  const cd = b.d - 2 * depth - 4;
  if (cw > 8 && cd > 8) {
    treesIn(ctx, rng, b.cx - cw / 2, b.cx + cw / 2, b.cz - cd / 2, b.cz + cd / 2, Math.round((cw * cd) / 350), 4, 8);
    if (!tall && rng.chance(0.5)) out.props.push({ type: 'playground', x: b.cx, z: b.cz, rot: 0, sx: Math.min(8, cw - 2), sz: Math.min(6, cd - 2) });
    if (tall) parkingLot(out, rng, b.cx - cw / 2, b.cx + cw / 2, b.cz - cd / 2, b.cz + cd / 2);
    else ground(ctx, b, b.cx, b.cz, `Courtyard drop — ${b.id}`);
  }
}

function fillTowersPark(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'towerspark', 'lawn', p.lawn);
  const n = Math.min(3, Math.max(1, Math.floor((b.w * b.d) / 3000)));
  const mult = hMult(b, env, true);
  const r = rect(b);
  const placed: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const s = rng.range(18, 24);
      const x = rng.range(r.minX + s / 2 + 4, r.maxX - s / 2 - 4);
      const z = rng.range(r.minZ + s / 2 + 4, r.maxZ - s / 2 - 4);
      if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < s + 10)) continue;
      placed.push({ x, z });
      const fl = floors(rng.range(14, 24), mult, 10, 34);
      const fc = facade(p, rng, 0.3);
      const solid = i === 0;
      const bld = ctx.addBuilding(spec(b, { name: `Residential Tower ${b.id}-${i + 1}`, kind: 'tower', cx: x, cz: z, w: s, d: s * rng.range(0.8, 1.2), h: fl * FLOOR_H, color: fc.color, material: fc.material, balconies: rng.chance(0.7), equipment: solid ? 1 : 3, solidTop: solid, keepout: solid ? { x, z, r: 4 } : undefined }));
      if (solid) roof(ctx, b, bld, `Rooftop drop — ${bld.name}`);
      break;
    }
  }
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, Math.round((b.w * b.d) / 700), 5, 11);
  parkingLot(out, rng, r.minX + 2, r.minX + 2 + Math.min(40, b.w - 4), r.maxZ - 12, r.maxZ - 2);
  ground(ctx, b, b.cx, b.cz, `Lawn drop — ${b.id}`);
}

function fillPocketPark(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'pocketpark', 'lawn', p.lawn);
  const r = rect(b);
  ground(ctx, b, b.cx + rng.range(-5, 5), b.cz + rng.range(-5, 5), `Park drop — ${b.id}`);
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, Math.round((b.w * b.d) / 220), 6, 13, 0.2);
  out.props.push({ type: 'playground', x: b.cx + rng.range(-b.w / 4, b.w / 4), z: b.cz + rng.range(-b.d / 4, b.d / 4), rot: 0, sx: 9, sz: 7 });
  for (let i = 0; i < 4; i++) out.props.push({ type: 'bench', x: rng.range(r.minX + 4, r.maxX - 4), z: rng.range(r.minZ + 4, r.maxZ - 4), rot: rng.range(0, Math.PI), sx: 1.8, sz: 0.5 });
  if (rng.chance(0.4)) out.props.push({ type: 'court', x: b.cx, z: b.cz + b.d / 4, rot: 0, sx: 15, sz: 28 });
}

function fillSchool(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'school', 'lawn', p.lawn);
  const r = rect(b);
  const fc = facade(p, rng);
  const main = ctx.addBuilding(spec(b, { name: `School ${b.id}`, kind: 'school', cx: r.minX + 22, cz: r.minZ + 12, w: Math.min(40, b.w - 8), d: 14, h: 2 * FLOOR_H + 1, color: fc.color, material: fc.material === 'glass' ? 'brick' : fc.material, equipment: 2 }));
  ctx.addBuilding(spec(b, { name: `School Wing ${b.id}`, kind: 'school', cx: r.minX + 9, cz: r.minZ + 30, w: 14, d: Math.min(30, b.d - 34), h: 2 * FLOOR_H + 1, color: fc.color, material: fc.material === 'glass' ? 'brick' : fc.material, equipment: 1 }));
  ctx.addBuilding(spec(b, { name: `Gymnasium ${b.id}`, kind: 'shed', cx: r.maxX - 14, cz: r.minZ + 12, w: 22, d: 16, h: 8, roof: 'barrel', color: jitter('#c9ccce', rng), material: 'metal' }));
  out.props.push({ type: 'pitch', x: b.cx + 8, z: r.maxZ - Math.min(30, b.d / 2 - 2), rot: 0, sx: Math.min(60, b.w - 20), sz: Math.min(40, b.d / 2 - 8) });
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.minZ + 6, 5, 5, 8);
  ground(ctx, b, main.cx + 10, main.cz + 14, `School drop — ${b.id}`, main.id);
}

function fillChurch(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'church', 'lawn', p.lawn);
  const alongX = b.w >= b.d;
  const nave = ctx.addBuilding(spec(b, { name: `Church ${b.id}`, kind: 'church', cx: b.cx, cz: b.cz, w: alongX ? 26 : 12, d: alongX ? 12 : 26, h: 9, roof: 'gable', color: jitter('#5f5a55', rng), material: 'stone' }));
  ctx.addBuilding(spec(b, { name: `Bell Tower ${b.id}`, kind: 'spire', cx: alongX ? b.cx - 15 : b.cx, cz: alongX ? b.cz : b.cz - 15, w: 6, d: 6, h: 18, color: jitter('#6b6560', rng), material: 'stone', mast: true }));
  treesIn(ctx, rng, b.cx - b.w / 2 + 3, b.cx + b.w / 2 - 3, b.cz - b.d / 2 + 3, b.cz + b.d / 2 - 3, 6, 6, 11, 0.4);
  ground(ctx, b, nave.cx + (alongX ? 0 : 14), nave.cz + (alongX ? 14 : 0), `Parish drop — ${b.id}`);
}

function fillCornerShop(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  // houses block with a shop on the busiest corner
  fillHouses(ctx, b, env, out);
  const r = rect(b);
  const x = b.streets.e >= b.streets.w ? r.maxX - 8 : r.minX + 8;
  const z = b.streets.s >= b.streets.n ? r.maxZ - 7 : r.minZ + 7;
  if (!ctx.clear(x, z, 7)) return;
  const fc = facade(p, rng);
  const shop = ctx.addBuilding(spec(b, { name: `Corner Shop ${b.id}`, kind: 'supermarket', cx: x, cz: z, w: 14, d: 12, h: 4.2, color: fc.color, material: fc.material === 'glass' ? 'brick' : fc.material, equipment: 1 }));
  out.props.push({ type: 'canopy', x: shop.cx, z: shop.cz + (z > b.cz ? 7 : -7), rot: 0, sx: 12, sz: 2 });
}

function fillGasStation(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'gasstation', 'paving', '#a9a8a2');
  out.props.push({ type: 'platform', x: b.cx + 6, z: b.cz, rot: 0, sx: 30, sz: 22, color: '#55585b' });
  const fc = facade(p, rng);
  ctx.addBuilding(spec(b, { name: `Fuel Station Shop ${b.id}`, kind: 'gasstation', cx: b.cx - b.w / 4, cz: b.cz, w: 12, d: 8, h: 4, color: fc.color, material: 'panel', equipment: 1 }));
  out.props.push({ type: 'canopy', x: b.cx + 6, z: b.cz, rot: 0, sx: 18, sz: 12, color: '#d8343a' });
  out.props.push({ type: 'pumps', x: b.cx + 6, z: b.cz, rot: 0, sx: 12, sz: 6 });
  fence(out, b.cx - b.w / 2, b.cx + b.w / 2, b.cz - b.d / 2, b.cz + b.d / 2, 'planter');
}

function fillSupermarket(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'supermarket', 'asphalt', '#5c5f62');
  const r = rect(b);
  const side = frontSide(b);
  const w = Math.min(48, b.w - 10);
  const d = Math.min(30, b.d / 2);
  const cz = side === 'n' ? r.maxZ - d / 2 - 3 : r.minZ + d / 2 + 3;
  const store = ctx.addBuilding(spec(b, { name: `Supermarket ${b.id}`, kind: 'bigbox', cx: b.cx, cz, w, d, h: 7, color: jitter(rng.pick(p.facade), rng), material: 'panel', equipment: 4 }));
  out.props.push({ type: 'canopy', x: store.cx, z: side === 'n' ? store.cz - d / 2 - 1.5 : store.cz + d / 2 + 1.5, rot: 0, sx: w * 0.6, sz: 3 });
  if (side === 'n') parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, store.cz - d / 2 - 4);
  else parkingLot(out, rng, r.minX + 2, r.maxX - 2, store.cz + d / 2 + 4, r.maxZ - 2);
  bays(out, store, side === 'n' ? 's' : 'n', 2);
  treesIn(ctx, rng, r.minX + 1, r.maxX - 1, r.minZ + 1, r.maxZ - 1, 4, 4, 7);
  ground(ctx, b, store.cx + w / 2 - 4, side === 'n' ? store.cz - d / 2 - 6 : store.cz + d / 2 + 6, `Store drop — ${b.id}`, store.id);
}

function fillSportsField(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'sportsfield', 'turf', '#5f8f4c');
  const alongX = b.w >= b.d;
  out.props.push({ type: 'pitch', x: b.cx, z: b.cz, rot: alongX ? 0 : Math.PI / 2, sx: Math.min(100, Math.max(b.w, b.d) - 16), sz: Math.min(64, Math.min(b.w, b.d) - 12) });
  const fc = facade(p, rng);
  const club = ctx.addBuilding(spec(b, { name: `Clubhouse ${b.id}`, kind: 'shed', cx: b.cx - b.w / 2 + 10, cz: b.cz - b.d / 2 + 6, w: 14, d: 8, h: 4, color: fc.color, material: 'plaster' }));
  ground(ctx, b, club.cx + 12, club.cz + 2, `Clubhouse drop — ${b.id}`, club.id);
  treesIn(ctx, rng, b.cx - b.w / 2 + 2, b.cx + b.w / 2 - 2, b.cz + b.d / 2 - 5, b.cz + b.d / 2 - 2, 8, 6, 11);
}

function fillPaddock(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'paddock', 'lawn', rng.pick(['#8a9a5a', '#99a35c', '#7f9456', '#a9a560']));
  fence(out, b.cx - b.w / 2 + 1, b.cx + b.w / 2 - 1, b.cz - b.d / 2 + 1, b.cz + b.d / 2 - 1);
  treesIn(ctx, rng, b.cx - b.w / 2 + 2, b.cx + b.w / 2 - 2, b.cz - b.d / 2 + 2, b.cz + b.d / 2 - 2, rng.int(2, 7), 7, 13, 0.3);
  if (rng.chance(0.5)) ctx.addBuilding(spec(b, { name: `Barn ${b.id}`, kind: 'shed', cx: b.cx + rng.range(-b.w / 4, b.w / 4), cz: b.cz + rng.range(-b.d / 4, b.d / 4), w: 14, d: 9, h: 5, roof: 'gable', color: '#7a4a3b', material: 'corrugated' }));
  if (rng.chance(0.3)) ground(ctx, b, b.cx, b.cz, `Farm gate drop — ${b.id}`);
}

const CROPS = ['#c9b458', '#8aa34a', '#6f9a45', '#b59a4e', '#9aa851', '#a58f48'];

function fillFields(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'fields', 'lawn', rng.pick(CROPS));
  const r = rect(b);
  // hedgerow boundary and a few field trees; one gate is a drop site
  fence(out, r.minX + 1, r.maxX - 1, r.minZ + 1, r.maxZ - 1, 'hedge');
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, rng.int(0, 4), 7, 12, 0.2);
  if (rng.chance(0.45)) ground(ctx, b, b.cx + rng.range(-b.w / 4, b.w / 4), r.minZ + 6, `Field gate drop — ${b.id}`);
}

function fillFarmstead(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'farmstead', 'lawn', '#8a9a5a');
  const r = rect(b);
  const fc = facade(p, rng);
  const house = ctx.addBuilding(spec(b, { name: `Farmhouse ${b.id}`, kind: 'house', cx: r.minX + 22, cz: r.minZ + 18, w: 12, d: 9, h: 6.5, roof: 'gable', color: fc.color, material: 'plaster', equipment: 1 }));
  ctx.addBuilding(spec(b, { name: `Barn ${b.id}`, kind: 'shed', cx: b.cx + 6, cz: b.cz + 4, w: 24, d: 13, h: 7.5, roof: 'gable', color: '#7a4a3b', material: 'corrugated' }));
  out.utilities.push({ id: `UT-FS-${b.id}`, kind: 'silo', x: b.cx + 28, z: b.cz - 2, height: rng.range(14, 20), radius: 3 });
  ctx.keepout(b.cx + 28, b.cz - 2, 6);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.maxZ - 12, r.maxZ - 2, 6, 7, 12, 0.3);
  ground(ctx, b, house.cx + 12, house.cz + 8, `Farmyard drop — ${b.id}`, house.id);
}

function fillBarns(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'barns', 'gravel', '#a1a094');
  const r = rect(b);
  const n = rng.int(2, 3);
  for (let i = 0; i < n; i++) {
    ctx.addBuilding(spec(b, { name: `Barn ${b.id}-${i + 1}`, kind: 'shed', cx: r.minX + 20 + i * 32, cz: b.cz + rng.range(-6, 6), w: 24, d: 12, h: rng.range(6, 8), roof: 'gable', color: rng.pick(['#7a4a3b', '#8a8f8a', '#6d5a48']), material: 'corrugated' }));
  }
  const k = rng.int(2, 4);
  for (let i = 0; i < k; i++) out.utilities.push({ id: `UT-BN-${b.id}-${i + 1}`, kind: 'silo', x: r.maxX - 12 - i * 8, z: r.minZ + 12, height: rng.range(16, 26), radius: 3.2 });
  ground(ctx, b, b.cx, r.maxZ - 8, `Barn yard drop — ${b.id}`);
}

function fillSolarFarm(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  addBlock(b, out, 'solarfarm', 'gravel', '#9a9a8c');
  const r = rect(b);
  for (let z = r.minZ + 6; z < r.maxZ - 6; z += 8) out.props.push({ type: 'solarfarm', x: b.cx, z, rot: 0, sx: b.w - 10, sz: 3.6 });
  fence(out, r.minX + 1, r.maxX - 1, r.minZ + 1, r.maxZ - 1);
  ctx.addBuilding(spec(b, { name: `Inverter Station ${b.id}`, kind: 'substation', cx: r.minX + 8, cz: r.minZ + 5, w: 8, d: 5, h: 3, color: '#8f9296', material: 'concrete' }));
  void env;
}

// -------------------------------------------------------------------------------------------------
// Commercial fillers
// -------------------------------------------------------------------------------------------------

function fillTower(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut, pair = false): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, pair ? 'towerpair' : 'tower', 'paving', p.paving);
  const mult = Math.min(2.2, hMult(b, env, true) * (0.6 + 0.6 * env.skyline.fbm(b.cx, b.cz, 1400, 2)));
  const podH = rng.pick([1, 2, 3, 4]) * FLOOR_H;
  const pw = b.w - rng.range(4, 8);
  const pd = b.d - rng.range(4, 8);
  const fcP = facade(p, rng, 0.2);
  const podium = ctx.addBuilding(spec(b, { name: `Podium ${b.id}`, kind: 'podium', cx: b.cx, cz: b.cz, w: pw, d: pd, h: podH, color: fcP.color, material: fcP.material, equipment: 2, solidTop: true, keepout: { x: b.cx + pw / 2 - 8, z: b.cz + pd / 2 - 8, r: 5 } }));
  const towers = pair ? 2 : 1;
  for (let i = 0; i < towers; i++) {
    const tw = Math.min(pw - 8, rng.range(18, 30));
    const td = Math.min(pd - 8, tw * rng.range(0.8, 1.25));
    const ox = pair ? (i === 0 ? -1 : 1) * (pw / 4) : rng.range(-(pw - tw) / 2 + 3, (pw - tw) / 2 - 3) * 0.5;
    const oz = rng.range(-(pd - td) / 2 + 3, (pd - td) / 2 - 3) * 0.5;
    const fl = floors(rng.range(14, 30), mult, 10, env.tall ? 56 : 42);
    const fc = facade(p, rng, 0.5);
    const t = ctx.addBuilding(spec(b, { name: `${pair ? 'Twin ' : ''}Tower ${b.id}-${i + 1}`, kind: 'tower', cx: b.cx + ox, cz: b.cz + oz, w: tw, d: td, h: fl * FLOOR_H, baseY: podH, color: fc.color, material: fc.material === 'brick' ? 'glass' : fc.material, equipment: 2 }));
    if (fl > 24 && rng.chance(0.6)) {
      ctx.addBuilding(spec(b, { name: `Crown ${b.id}-${i + 1}`, kind: 'crown', cx: t.cx, cz: t.cz, w: tw * 0.55, d: td * 0.55, h: rng.range(6, 10), baseY: t.baseY + t.h, color: fc.color, material: 'glass', mast: rng.chance(0.6) }));
    } else if (rng.chance(0.5)) {
      // stepped setback
      ctx.addBuilding(spec(b, { name: `Setback ${b.id}-${i + 1}`, kind: 'tower', cx: t.cx, cz: t.cz, w: tw * 0.7, d: td * 0.7, h: rng.int(3, 8) * FLOOR_H, baseY: t.baseY + t.h, color: fc.color, material: t.material, equipment: 1, mast: rng.chance(0.4) }));
    }
  }
  roof(ctx, b, podium, `Podium drop — ${b.id}`, { x: b.cx + pw / 2 - 8, z: b.cz + pd / 2 - 8 });
  const r = rect(b);
  for (let i = 0; i < 4; i++) ctx.addTree(rng.range(r.minX + 1, r.maxX - 1), rng.chance(0.5) ? r.minZ + 1 : r.maxZ - 1, 4, 7);
}

function fillOfficeMid(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'officemid', 'paving', p.paving);
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const D = alongX ? b.d : b.w;
  const n = D > 60 ? 2 : 1;
  const depth = Math.min(16, D / n - 8);
  const mult = hMult(b, env, true);
  let padDone = false;
  for (let i = 0; i < n; i++) {
    const across = n === 1 ? 0 : (i === 0 ? -1 : 1) * (D / 4);
    const len = L * rng.range(0.6, 0.9);
    const fl = floors(rng.range(6, 11), mult, 3, 16);
    const fc = facade(p, rng, 0.35);
    const solid = !padDone && rng.chance(0.6);
    const cx = alongX ? b.cx + rng.range(-(L - len) / 2, (L - len) / 2) : b.cx + across;
    const cz = alongX ? b.cz + across : b.cz + rng.range(-(L - len) / 2, (L - len) / 2);
    const bld = ctx.addBuilding(spec(b, { name: `Office Midrise ${b.id}-${i + 1}`, kind: 'midrise', cx, cz, w: alongX ? len : depth, d: alongX ? depth : len, h: fl * FLOOR_H, color: fc.color, material: fc.material, equipment: solid ? 1 : 3, solidTop: solid, keepout: solid ? { x: cx, z: cz, r: 4 } : undefined }));
    if (solid) {
      roof(ctx, b, bld, `Rooftop drop — ${bld.name}`);
      padDone = true;
    }
  }
  const r = rect(b);
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.maxZ - 14, r.maxZ - 2);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 1, r.minZ + 3, 4, 4, 7);
}

function fillStrip(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'strip', 'asphalt', '#5a5d60');
  const side = frontSide(b);
  const alongX = side === 'n' || side === 's';
  const r = rect(b);
  const depth = Math.min(16, (alongX ? b.d : b.w) / 2 - 4);
  const len = alongX ? b.w : b.d;
  let t = -len / 2 + 2;
  let k = 0;
  while (t < len / 2 - 8) {
    const f = Math.min(rng.range(9, 18), len / 2 - 2 - t);
    const fc = facade(p, rng, 0.15);
    const h = rng.pick([4.2, 4.5, 7.5, 7.8]);
    const back = side === 'n' ? r.maxZ - depth / 2 - 2 : side === 's' ? r.minZ + depth / 2 + 2 : side === 'e' ? r.minX + depth / 2 + 2 : r.maxX - depth / 2 - 2;
    const cx = alongX ? b.cx + t + f / 2 : back;
    const cz = alongX ? back : b.cz + t + f / 2;
    ctx.addBuilding(spec(b, { name: `Shop ${b.id}-${++k}`, kind: 'supermarket', cx, cz, w: alongX ? f : depth, d: alongX ? depth : f, h, color: fc.color, material: fc.material, equipment: 1 }));
    if (rng.chance(0.5)) out.props.push({ type: 'billboard', x: cx + (alongX ? 0 : (side === 'e' ? -1 : 1) * (depth / 2 + 1)), z: cz + (alongX ? (side === 'n' ? -1 : 1) * (depth / 2 + 1) : 0), rot: alongX ? 0 : Math.PI / 2, sx: Math.min(6, f - 2), sz: 0.3 });
    t += f;
  }
  if (alongX) parkingLot(out, rng, r.minX + 2, r.maxX - 2, side === 'n' ? r.minZ + 2 : r.minZ + depth + 6, side === 'n' ? r.maxZ - depth - 6 : r.maxZ - 2);
  else parkingLot(out, rng, side === 'w' ? r.minX + 2 : r.minX + depth + 6, side === 'w' ? r.maxX - depth - 6 : r.maxX - 2, r.minZ + 2, r.maxZ - 2, false);
  ground(ctx, b, b.cx, b.cz, `Retail drop — ${b.id}`);
}

function fillPlaza(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'plaza', 'paving', p.paving);
  out.props.push({ type: 'fountain', x: b.cx, z: b.cz, rot: 0, sx: 9, sz: 9 });
  ctx.keepout(b.cx, b.cz, 7);
  const r = rect(b);
  ctx.addBuilding(spec(b, { name: `Café Pavilion ${b.id}`, kind: 'pavilion', cx: r.minX + 8, cz: r.minZ + 8, w: 8, d: 7, h: 4, color: '#888a86', material: 'glass' }));
  for (let x = r.minX + 6; x < r.maxX - 4; x += 8) {
    ctx.addTree(x, r.minZ + 4, 5, 8);
    ctx.addTree(x, r.maxZ - 4, 5, 8);
  }
  for (let i = 0; i < 6; i++) out.props.push({ type: 'bench', x: b.cx + rng.range(-b.w / 3, b.w / 3), z: b.cz + rng.range(-b.d / 3, b.d / 3), rot: rng.range(0, Math.PI), sx: 1.8, sz: 0.5 });
  ground(ctx, b, b.cx + 14, b.cz + 10, `Plaza drop — ${b.id}`);
}

function fillHotel(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'hotel', 'paving', p.paving);
  const alongX = b.w >= b.d;
  const mult = hMult(b, env, true);
  const fl = floors(rng.range(10, 18), mult, 6, 30);
  const len = Math.min((alongX ? b.w : b.d) - 10, 60);
  const fc = facade(p, rng, 0.4);
  const h = ctx.addBuilding(spec(b, { name: `Hotel ${b.id}`, kind: 'hotel', cx: b.cx, cz: b.cz - (alongX ? b.d / 6 : 0), w: alongX ? len : 18, d: alongX ? 18 : len, h: fl * FLOOR_H, color: fc.color, material: fc.material, balconies: rng.chance(0.6), equipment: 1, solidTop: true, keepout: { x: b.cx, z: b.cz - (alongX ? b.d / 6 : 0), r: 4 } }));
  roof(ctx, b, h, `Hotel rooftop drop — ${b.id}`);
  const side = frontSide(b);
  const r = rect(b);
  out.props.push({ type: 'canopy', x: h.cx, z: side === 'n' ? h.cz - h.d / 2 - 2 : h.cz + h.d / 2 + 2, rot: 0, sx: 10, sz: 4 });
  if (rng.chance(0.5)) out.props.push({ type: 'pool', x: h.cx + h.w / 2 - 10, z: h.cz + h.d / 2 + 8, rot: 0, sx: 12, sz: 6 });
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.maxZ - 12, r.maxZ - 2);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 1, r.minZ + 4, 4, 4, 7, 0, 'palm');
}

function fillParkingGarage(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'parkinggarage', 'asphalt', '#5a5d60');
  const levels = rng.int(3, 6);
  const g = ctx.addBuilding(spec(b, { name: `Parking Garage ${b.id}`, kind: 'parking', cx: b.cx, cz: b.cz, w: b.w - 6, d: b.d - 6, h: levels * 3, color: jitter('#b5b5b0', rng), material: 'concrete', solidTop: true, keepout: { x: b.cx, z: b.cz, r: 14 }, equipment: 1 }));
  roof(ctx, b, g, `Garage roof drop — ${b.id}`);
  void p;
}

function fillMall(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'mall', 'asphalt', '#5c5f62');
  const r = rect(b);
  const alongX = b.w >= b.d;
  const w = Math.min(alongX ? b.w * 0.6 : b.w * 0.75, 120);
  const d = Math.min(alongX ? b.d * 0.75 : b.d * 0.6, 100);
  const cx = alongX ? r.minX + w / 2 + 4 : b.cx;
  const cz = alongX ? b.cz : r.minZ + d / 2 + 4;
  const fc = facade(p, rng, 0.1);
  const mall = ctx.addBuilding(spec(b, { name: `Shopping Mall ${b.id}`, kind: 'mall', cx, cz, w, d, h: rng.pick([9, 12, 14]), color: fc.color, material: 'panel', equipment: 8, solar: rng.chance(0.5) }));
  ctx.addBuilding(spec(b, { name: `Mall Entrance ${b.id}`, kind: 'mall', cx: alongX ? cx + w / 2 + 4 : cx, cz: alongX ? cz : cz + d / 2 + 4, w: alongX ? 8 : 24, d: alongX ? 24 : 8, h: 10, color: jitter(rng.pick(p.glass), rng), material: 'glass' }));
  if (alongX) parkingLot(out, rng, cx + w / 2 + 14, r.maxX - 2, r.minZ + 2, r.maxZ - 2, false);
  else parkingLot(out, rng, r.minX + 2, r.maxX - 2, cz + d / 2 + 14, r.maxZ - 2);
  bays(out, mall, alongX ? 'n' : 'w', 3);
  ground(ctx, b, alongX ? cx + w / 2 + 9 : cx + w / 2 - 6, alongX ? cz + d / 2 - 6 : cz + d / 2 + 9, `Mall drop — ${b.id}`, mall.id);
  treesIn(ctx, rng, r.minX + 1, r.maxX - 1, r.minZ + 1, r.maxZ - 1, 10, 4, 7);
}

function fillCivic(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'civic', 'paving', p.paving);
  const hall = ctx.addBuilding(spec(b, { name: `City Hall ${b.id}`, kind: 'office', cx: b.cx, cz: b.cz, w: Math.min(b.w - 16, 48), d: Math.min(b.d - 16, 30), h: 5 * FLOOR_H, color: jitter('#c9c3b5', rng), material: 'stone', equipment: 2 }));
  ctx.addBuilding(spec(b, { name: `Hall Dome ${b.id}`, kind: 'crown', cx: b.cx, cz: b.cz, w: 12, d: 12, h: 8, baseY: hall.baseY + hall.h, color: '#7a8b74', material: 'metal' }));
  const r = rect(b);
  for (let x = r.minX + 5; x < r.maxX - 3; x += 7) {
    ctx.addTree(x, r.minZ + 3, 5, 8);
    ctx.addTree(x, r.maxZ - 3, 5, 8);
  }
  out.noFly.push({ id: `NFZ-GOV-${b.id}`, name: 'Government quarter', reason: 'Government building — restricted airspace', shape: { type: 'box', minX: r.minX - 10, maxX: r.maxX + 10, minZ: r.minZ - 10, maxZ: r.maxZ + 10 }, maxY: 120, closable: false, active: true, source: 'auto' });
}

function fillConstruction(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'construction', 'gravel', '#8d8777');
  const mult = hMult(b, env, true);
  const fl = floors(rng.range(6, 14), mult, 4, 24);
  const frame = ctx.addBuilding(spec(b, { name: `Building Under Construction ${b.id}`, kind: 'frame', cx: b.cx - 4, cz: b.cz + 3, w: Math.min(b.w - 14, 28), d: Math.min(b.d - 14, 22), h: fl * FLOOR_H, color: '#9a9a96', material: 'concrete' }));
  const mast = frame.h + rng.range(14, 22);
  out.cranes.push({ id: `CR-${out.cranes.length + 1}`, x: frame.cx + frame.w / 2 + 4, z: frame.cz - frame.d / 2 - 3, mastHeight: mast, jibLength: rng.range(22, 34), jibAngle: rng.range(0, Math.PI * 2), kind: 'tower' });
  fence(out, b.cx - b.w / 2 + 1, b.cx + b.w / 2 - 1, b.cz - b.d / 2 + 1, b.cz + b.d / 2 - 1);
  for (let i = 0; i < 3; i++) out.containers.push({ x: b.cx + b.w / 2 - 6, z: b.cz - b.d / 2 + 6 + i * 3.2, rot: 0, stack: 1, color: '#4b6b4a' });
}

// -------------------------------------------------------------------------------------------------
// Industrial fillers
// -------------------------------------------------------------------------------------------------

const WAREHOUSE = ['#c9ccce', '#b7bcc0', '#d4d6d3', '#a9b2b8', '#9ea4a8', '#cfd0cc'];
const CONTAINER = ['#8c3b34', '#2f5d7c', '#c18a2c', '#4b6b4a', '#7b7f84', '#b0b3b6', '#9a4f8f'];

function fillWarehouses(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'warehouses', rng.chance(0.6) ? 'gravel' : 'asphalt', rng.pick(['#9f9f9a', '#a3a39e', '#9a9a95']));
  const alongX = b.w >= b.d;
  const L = alongX ? b.w : b.d;
  const D = alongX ? b.d : b.w;
  const rows = D > 150 ? 2 : 1;
  const rowD = (D - 20) / rows;
  const n = Math.max(1, Math.min(5, Math.floor(L / rng.range(42, 64))));
  const pitch = (L - 6) / n;
  let k = 0;
  for (let row = 0; row < rows; row++) {
    const depth = Math.min(rowD - 26, rng.range(28, 48));
    const back = -D / 2 + 10 + row * rowD + depth / 2 + (row === 0 ? 0 : 6);
    for (let i = 0; i < n; i++) {
      if (rng.chance(0.08)) continue;
      const len = pitch - rng.range(6, 12);
      const along = -(L - 6) / 2 + pitch * (i + 0.5);
      const cx = alongX ? b.cx + along : b.cx + back;
      const cz = alongX ? b.cz + back : b.cz + along;
      const w = ctx.addBuilding(spec(b, { name: `Warehouse ${b.id}-${++k}`, kind: 'warehouse', cx, cz, w: alongX ? len : depth, d: alongX ? depth : len, h: rng.range(9, 13), roof: rng.chance(0.25) ? 'barrel' : 'flat', color: jitter(rng.pick(WAREHOUSE), rng), material: rng.chance(0.6) ? 'corrugated' : 'metal', equipment: 3, solar: rng.chance(0.3) }));
      bays(out, w, alongX ? 's' : 'e', Math.max(2, Math.floor(len / 9)));
      for (let t = 0; t < Math.floor(len / 9); t++) {
        if (!rng.chance(0.45)) continue;
        const ax = alongX ? w.cx - (len - 8) / 2 + t * 9 : w.cx + w.w / 2 + 9;
        const az = alongX ? w.cz + w.d / 2 + 9 : w.cz - (len - 8) / 2 + t * 9;
        out.parking.push({ x: ax, z: az, rot: alongX ? 0 : Math.PI / 2, w: 3.4, d: 16 });
      }
      if (rng.chance(0.5)) for (let c = 0; c < rng.int(2, 6); c++) out.containers.push({ x: alongX ? w.cx + w.w / 2 + 4 : w.cx - 4 - c * 3, z: alongX ? w.cz - w.d / 2 + 4 + c * 3 : w.cz + w.d / 2 + 4, rot: alongX ? 0 : Math.PI / 2, stack: rng.int(1, 2), color: rng.pick(CONTAINER) });
    }
  }
  const r = rect(b);
  if (alongX) parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.maxZ - 14, r.maxZ - 2);
  else parkingLot(out, rng, r.maxX - 14, r.maxX - 2, r.minZ + 2, r.maxZ - 2, false);
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 1, r.minZ + 3, Math.round(b.w / 30), 4, 7);
  ground(ctx, b, alongX ? r.maxX - 8 : r.minX + 8, alongX ? r.minZ + 8 : r.maxZ - 8, `Yard drop — ${b.id}`);
}

function fillFactory(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'factory', 'gravel', '#9a9a95');
  const r = rect(b);
  const hw = Math.min(b.w - 30, Math.max(40, b.w * 0.55));
  const hd = Math.min(b.d - 24, Math.max(30, b.d * 0.5));
  const hall = ctx.addBuilding(spec(b, { name: `Factory Hall ${b.id}`, kind: 'factory', cx: r.minX + hw / 2 + 6, cz: b.cz, w: hw, d: hd, h: rng.range(9, 12), roof: 'sawtooth', color: jitter(rng.pick(WAREHOUSE), rng), material: 'corrugated' }));
  if (b.w - hw > 70) {
    ctx.addBuilding(spec(b, { name: `Assembly Hall ${b.id}`, kind: 'warehouse', cx: r.maxX - 24, cz: r.maxZ - Math.min(30, b.d / 3), w: 36, d: Math.min(40, b.d / 2 - 8), h: 10, roof: 'barrel', color: jitter(rng.pick(WAREHOUSE), rng), material: 'metal', equipment: 2 }));
  }
  ctx.addBuilding(spec(b, { name: `Factory Office ${b.id}`, kind: 'office', cx: r.maxX - 12, cz: r.minZ + 12, w: 18, d: 14, h: 2 * FLOOR_H, color: jitter('#c4c2bb', rng), material: 'concrete', equipment: 2 }));
  const stacks = rng.int(1, 3);
  for (let i = 0; i < stacks; i++) out.utilities.push({ id: `UT-S-${b.id}-${i + 1}`, kind: 'stack', x: hall.cx - hall.w / 2 + 8 + i * 10, z: hall.cz - hall.d / 2 - 6, height: rng.range(30, 48), radius: 2 });
  for (let i = 0; i < rng.int(1, 3); i++) out.utilities.push({ id: `UT-T-${b.id}-${i + 1}`, kind: 'tank', x: hall.cx + hall.w / 2 + 10, z: hall.cz - hall.d / 2 + 8 + i * 12, height: rng.range(8, 13), radius: rng.range(3.5, 5) });
  bays(out, hall, 's', Math.max(3, Math.floor(hw / 14)));
  for (let t = 0; t < Math.floor(hw / 14); t++) if (rng.chance(0.4)) out.parking.push({ x: hall.cx - (hw - 8) / 2 + t * 14, z: hall.cz + hall.d / 2 + 9, rot: 0, w: 3.4, d: 16 });
  parkingLot(out, rng, r.maxX - 40, r.maxX - 2, r.minZ + 24, r.minZ + 40);
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  ground(ctx, b, r.maxX - 12, r.minZ + 48, `Factory gate drop — ${b.id}`);
}

function fillSheds(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'sheds', 'gravel', '#a1a094');
  const r = rect(b);
  let k = 0;
  for (const lot of lots(b, rng, 20, 34, Math.min(b.w, b.d) > 60 ? 2 : 1, 0.2)) {
    if (lot.skipped) continue;
    const w = Math.min(lot.frontage - 5, rng.range(12, 22));
    const d = Math.min(lot.depth - 10, rng.range(10, 18));
    if (w < 8 || d < 7) continue;
    ctx.addBuilding(spec(b, { name: `Workshop ${b.id}-${++k}`, kind: 'shed', cx: lot.cx + rng.range(-1, 1), cz: lot.cz + rng.range(-1, 1), w: lot.fx ? d : w, d: lot.fx ? w : d, h: rng.range(4.5, 7), roof: rng.chance(0.5) ? 'gable' : 'flat', color: jitter(rng.pick(WAREHOUSE), rng), material: 'corrugated', equipment: 1 }));
  }
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  ground(ctx, b, b.cx, b.cz, `Workshop drop — ${b.id}`);
}

function fillTanks(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'tanks', 'gravel', '#9c9b90');
  const r = rect(b);
  const cols = Math.max(1, Math.floor((b.w - 10) / 22));
  const rows = Math.max(1, Math.floor((b.d - 10) / 22));
  let k = 0;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (rng.chance(0.2)) continue;
      out.utilities.push({ id: `UT-TK-${b.id}-${++k}`, kind: 'tank', x: r.minX + 11 + i * 22, z: r.minZ + 11 + j * 22, height: rng.range(10, 16), radius: rng.range(6, 8.5) });
    }
  }
  ctx.addBuilding(spec(b, { name: `Pump House ${b.id}`, kind: 'shed', cx: r.maxX - 8, cz: r.maxZ - 6, w: 10, d: 7, h: 4, color: '#c9ccce', material: 'metal' }));
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
}

function fillSilos(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'silos', 'gravel', '#a1a094');
  const n = rng.int(3, 7);
  for (let i = 0; i < n; i++) out.utilities.push({ id: `UT-SL-${b.id}-${i + 1}`, kind: 'silo', x: b.cx - (n * 9) / 2 + i * 9 + 4.5, z: b.cz - b.d / 6, height: rng.range(22, 34), radius: 3.8 });
  ctx.addBuilding(spec(b, { name: `Grain Store ${b.id}`, kind: 'warehouse', cx: b.cx, cz: b.cz + b.d / 4, w: Math.min(b.w - 10, 36), d: Math.min(b.d / 2 - 8, 18), h: 9, roof: 'gable', color: jitter(rng.pick(WAREHOUSE), rng), material: 'corrugated' }));
  ground(ctx, b, b.cx + b.w / 2 - 8, b.cz - b.d / 2 + 8, `Silo yard drop — ${b.id}`);
}

function fillTruckDepot(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'truckdepot', 'asphalt', '#8e8e89');
  const r = rect(b);
  ctx.addBuilding(spec(b, { name: `Haulage Office ${b.id}`, kind: 'office', cx: r.minX + 12, cz: r.minZ + 9, w: 18, d: 10, h: 2 * FLOOR_H, color: jitter('#c4c2bb', rng), material: 'panel', equipment: 1 }));
  ctx.addBuilding(spec(b, { name: `Service Bay ${b.id}`, kind: 'shed', cx: r.maxX - 16, cz: r.minZ + 11, w: 24, d: 14, h: 7, color: jitter(rng.pick(WAREHOUSE), rng), material: 'corrugated' }));
  for (let z = r.minZ + 34; z + 16 <= r.maxZ - 4; z += 24) {
    for (let x = r.minX + 6; x + 4 <= r.maxX - 4; x += 4.2) {
      if (rng.chance(0.35)) continue;
      out.parking.push({ x, z, rot: 0, w: 3.4, d: 16 });
    }
  }
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  ground(ctx, b, r.minX + 36, r.minZ + 12, `Depot yard drop — ${b.id}`);
}

function fillSubstation(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'substation', 'gravel', '#a9a9a2');
  const r = rect(b);
  ctx.addBuilding(spec(b, { name: `Electrical Substation ${b.id}`, kind: 'substation', cx: b.cx, cz: b.cz, w: Math.min(26, b.w - 20), d: Math.min(18, b.d - 20), h: 5, color: '#8f9296', material: 'concrete' }));
  const ids: string[] = [];
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
    const id = `UT-P-${b.id}-${ids.length + 1}`;
    ids.push(id);
    out.utilities.push({ id, kind: 'pylon', x: b.cx + ox * (b.w / 2 - 8), z: b.cz + oz * (b.d / 2 - 8), height: rng.range(30, 40), radius: 2.2 });
  }
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  out.noFly.push({ id: `NFZ-SUB-${b.id}`, name: 'Substation exclusion', reason: 'High-voltage infrastructure', shape: { type: 'box', minX: r.minX - 4, maxX: r.maxX + 4, minZ: r.minZ - 4, maxZ: r.maxZ + 4 }, maxY: 120, closable: false, active: true, source: 'auto' });
}

function fillWaterTower(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'watertower', 'lawn', '#7d9560');
  out.utilities.push({ id: `UT-W-${b.id}`, kind: 'watertower', x: b.cx, z: b.cz, height: rng.range(28, 38), radius: 6 });
  treesIn(ctx, rng, b.cx - b.w / 2 + 3, b.cx + b.w / 2 - 3, b.cz - b.d / 2 + 3, b.cz + b.d / 2 - 3, 6, 5, 9);
  ground(ctx, b, b.cx + 14, b.cz + 12, `Utility drop — ${b.id}`);
}

function fillContainerYard(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'containeryard', 'asphalt', '#9a9a95');
  const r = rect(b);
  const alongX = b.w >= b.d;
  const rows = Math.floor((Math.min(b.w, b.d) - 16) / 4.6);
  const cols = Math.floor((Math.max(b.w, b.d) - 30) / 7);
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (j % 3 === 2 || rng.chance(0.22)) continue;
      const along = r.minX + 10 + i * 7;
      const across = r.minZ + 8 + j * 4.6;
      out.containers.push({ x: alongX ? along : b.cx - b.w / 2 + 8 + j * 4.6, z: alongX ? across : b.cz - b.d / 2 + 10 + i * 7, rot: alongX ? 0 : Math.PI / 2, stack: rng.int(1, 3), color: rng.pick(CONTAINER) });
    }
  }
  out.cranes.push({ id: `CR-G-${b.id}`, x: alongX ? b.cx : b.cx + b.w / 2 - 12, z: alongX ? b.cz + b.d / 2 - 12 : b.cz, mastHeight: 28, jibLength: 22, jibAngle: alongX ? 0 : Math.PI / 2, kind: 'gantry' });
  const office = ctx.addBuilding(spec(b, { name: `Yard Office ${b.id}`, kind: 'shed', cx: r.maxX - 10, cz: r.maxZ - 8, w: 10, d: 7, h: 3.4, color: '#d0d0cb', material: 'concrete' }));
  ground(ctx, b, office.cx - 12, office.cz, `Yard office drop — ${b.id}`, office.id);
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
}

function fillQuay(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'quay', 'asphalt', '#8f9094');
  const r = rect(b);
  // quay cranes along the water-side (east) edge, containers behind
  const n = Math.max(1, Math.floor(b.d / 60));
  for (let i = 0; i < n; i++) out.cranes.push({ id: `CR-Q-${b.id}-${i + 1}`, x: r.maxX - 14, z: r.minZ + 30 + i * 60, mastHeight: 48, jibLength: 40, jibAngle: Math.PI / 2, kind: 'quay' });
  for (let i = 0; i < Math.floor((b.w - 50) / 7); i++) {
    for (let j = 0; j < Math.floor((b.d - 16) / 4.6); j++) {
      if (j % 4 === 3 || rng.chance(0.3)) continue;
      out.containers.push({ x: r.minX + 10 + i * 7, z: r.minZ + 8 + j * 4.6, rot: 0, stack: rng.int(1, 4), color: rng.pick(CONTAINER) });
    }
  }
  const shed = ctx.addBuilding(spec(b, { name: `Transit Shed ${b.id}`, kind: 'warehouse', cx: r.minX + 30, cz: r.maxZ - 16, w: Math.min(50, b.w - 40), d: 22, h: 10, roof: 'barrel', color: jitter(rng.pick(WAREHOUSE), rng), material: 'corrugated' }));
  ground(ctx, b, shed.cx + shed.w / 2 + 8, shed.cz, `Quay drop — ${b.id}`, shed.id);
  for (let i = 0; i < 3; i++) out.props.push({ type: 'boat', x: r.maxX + 30 + i * 12, z: r.minZ + 30 + i * 70, rot: Math.PI / 2, sx: 60, sz: 12, color: rng.pick(['#2f3c4c', '#6b2d2a', '#1f4f5f']) });
}

// -------------------------------------------------------------------------------------------------
// Special districts
// -------------------------------------------------------------------------------------------------

function fillPark(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'park', 'lawn', rng.pick(['#6d8a52', '#6f8e55', '#688650']));
  const r = rect(b);
  const area = b.w * b.d;
  // ponds in big parks
  if (area > 20000 && rng.chance(0.7)) {
    const pw = Math.min(b.w * 0.35, 90);
    const pd = Math.min(b.d * 0.35, 70);
    const px = b.cx + rng.range(-b.w / 6, b.w / 6);
    const pz = b.cz + rng.range(-b.d / 6, b.d / 6);
    out.props.push({ type: 'pool', x: px, z: pz, rot: rng.range(0, Math.PI), sx: pw, sz: pd, color: '#4a7a8f' });
    ctx.keepout(px, pz, Math.max(pw, pd) / 2 + 2);
  }
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, Math.round(area / 190), 6, 15, 0.25);
  // winding path represented as a few paved strips
  for (let i = 0; i < Math.max(1, Math.round(area / 15000)); i++) out.props.push({ type: 'platform', x: b.cx + rng.range(-b.w / 3, b.w / 3), z: b.cz + rng.range(-b.d / 3, b.d / 3), rot: rng.range(0, Math.PI), sx: rng.range(30, 80), sz: 2.4, color: '#b0afa9' });
  if (rng.chance(0.6)) out.props.push({ type: 'playground', x: r.minX + 20, z: r.minZ + 18, rot: 0, sx: 12, sz: 9 });
  if (area > 12000 && rng.chance(0.5)) out.props.push({ type: 'court', x: r.maxX - 24, z: r.maxZ - 24, rot: 0, sx: 15, sz: 28 });
  if (area > 30000 && rng.chance(0.5)) ctx.addBuilding(spec(b, { name: `Park Café ${b.id}`, kind: 'pavilion', cx: r.minX + 16, cz: r.maxZ - 14, w: 10, d: 8, h: 4, color: '#8a8c86', material: 'glass' }));
  for (let i = 0; i < Math.max(2, Math.round(area / 6000)); i++) out.props.push({ type: 'bench', x: rng.range(r.minX + 4, r.maxX - 4), z: rng.range(r.minZ + 4, r.maxZ - 4), rot: rng.range(0, Math.PI), sx: 1.8, sz: 0.5 });
  const nDrops = Math.max(1, Math.round(area / 25000));
  for (let i = 0; i < nDrops; i++) ground(ctx, b, rng.range(r.minX + 12, r.maxX - 12), rng.range(r.minZ + 12, r.maxZ - 12), `Park drop — ${b.id}${nDrops > 1 ? ` #${i + 1}` : ''}`);
}

function fillCampus(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'campus', 'lawn', p.lawn);
  const r = rect(b);
  const alongX = b.w >= b.d;
  const n = Math.max(1, Math.min(4, Math.floor((b.w * b.d) / 4500)));
  let k = 0;
  const names = ['Lecture Hall', 'Library', 'Laboratory', 'Faculty Building', 'Student Centre', 'Residence Hall'];
  const placed: { x: number; z: number; w: number; d: number }[] = [];
  for (let i = 0; i < n; i++) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const w = rng.range(22, 40);
      const d = rng.range(14, 24);
      const x = rng.range(r.minX + w / 2 + 6, r.maxX - w / 2 - 6);
      const z = rng.range(r.minZ + d / 2 + 6, r.maxZ - d / 2 - 6);
      if (placed.some((q) => Math.abs(q.x - x) < (q.w + w) / 2 + 8 && Math.abs(q.z - z) < (q.d + d) / 2 + 8)) continue;
      placed.push({ x, z, w, d });
      const fc = facade(p, rng, 0.15);
      const name = names[(k++) % names.length];
      const fl = name === 'Residence Hall' ? rng.int(5, 9) : rng.int(2, 5);
      const bld = ctx.addBuilding(spec(b, { name: `${name} ${b.id}`, kind: 'midrise', cx: x, cz: z, w: alongX ? w : d, d: alongX ? d : w, h: fl * FLOOR_H, color: fc.color, material: fc.material === 'glass' ? 'brick' : fc.material, equipment: 2, solidTop: i === 0, keepout: i === 0 ? { x, z, r: 4 } : undefined }));
      if (i === 0) roof(ctx, b, bld, `Campus rooftop drop — ${b.id}`);
      break;
    }
  }
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, Math.round((b.w * b.d) / 600), 6, 12, 0.2);
  ground(ctx, b, b.cx, b.cz, `Quad drop — ${b.id}`);
  if (b.w > 90 && b.d > 70 && rng.chance(0.4)) out.props.push({ type: 'pitch', x: r.maxX - 40, z: r.maxZ - 30, rot: 0, sx: 60, sz: 40 });
}

function fillHospital(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'hospital', 'paving', '#b5b4ae');
  const r = rect(b);
  const main = ctx.addBuilding(spec(b, { name: `General Hospital ${b.id}`, kind: 'hospital', cx: b.cx, cz: b.cz - 6, w: Math.min(b.w - 30, 70), d: Math.min(b.d - 40, 32), h: rng.int(7, 12) * FLOOR_H, color: jitter('#d8dad8', rng), material: 'panel', equipment: 3, solidTop: true, keepout: { x: b.cx, z: b.cz - 6, r: 10 } }));
  ctx.addBuilding(spec(b, { name: `Hospital Wing A ${b.id}`, kind: 'midrise', cx: main.cx - main.w / 2 + 12, cz: main.cz + main.d / 2 + 12, w: 24, d: 20, h: 4 * FLOOR_H, color: jitter('#d8dad8', rng), material: 'panel', equipment: 2 }));
  ctx.addBuilding(spec(b, { name: `Hospital Wing B ${b.id}`, kind: 'midrise', cx: main.cx + main.w / 2 - 12, cz: main.cz + main.d / 2 + 12, w: 24, d: 20, h: 3 * FLOOR_H, color: jitter('#d8dad8', rng), material: 'panel', equipment: 2 }));
  out.props.push({ type: 'helipad', x: main.cx, z: main.cz, rot: 0, sx: 16, sz: 16, color: `${main.baseY + main.h}` });
  out.props.push({ type: 'canopy', x: main.cx, z: main.cz + main.d / 2 + 24, rot: 0, sx: 16, sz: 5, color: '#c83a3a' });
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.maxZ - 16, r.maxZ - 2);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.minZ + 8, 8, 5, 9);
  out.noFly.push({ id: `NFZ-HELI-${b.id}`, name: 'Hospital helipad airspace', reason: 'Medical helicopter operations', shape: { type: 'circle', x: main.cx, z: main.cz, r: 60 }, maxY: 150, closable: false, active: true, source: 'auto' });
  // pharmacy / ER drops sit outside the helipad circle
  ground(ctx, b, main.cx - main.w / 2 - 12, main.cz + main.d / 2 + 36, `Emergency drop — ${b.id}`, main.id);
  ground(ctx, b, main.cx + main.w / 2 + 12, main.cz + main.d / 2 + 36, `Pharmacy drop — ${b.id}`, main.id);
}

function fillStadium(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'stadium', 'asphalt', '#8e8e89');
  const r = rect(b);
  const w = Math.min(b.w - 40, 190);
  const d = Math.min(b.d - 40, 150);
  ctx.addBuilding(spec(b, { name: `Stadium ${b.id}`, kind: 'stadium', cx: b.cx, cz: b.cz, w, d, h: rng.range(28, 38), color: jitter('#c9ccce', rng), material: 'panel' }));
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, b.cz - d / 2 - 8);
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, b.cz + d / 2 + 8, r.maxZ - 2);
  out.noFly.push({ id: `NFZ-STADIUM-${b.id}`, name: 'Stadium event airspace', reason: 'Temporary flight restriction during events', shape: { type: 'circle', x: b.cx, z: b.cz, r: Math.max(w, d) / 2 + 60 }, maxY: 150, closable: true, active: false, source: 'auto' });
  ground(ctx, b, r.minX + 12, b.cz, `Stadium gate drop — ${b.id}`);
}

function fillCemetery(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'cemetery', 'lawn', '#6f8a55');
  const r = rect(b);
  for (let x = r.minX + 6; x < r.maxX - 6; x += 3.2) {
    for (let z = r.minZ + 6; z < r.maxZ - 6; z += 4) {
      if (rng.chance(0.3) || Math.abs(x - b.cx) < 3 || Math.abs(z - b.cz) < 3) continue;
      out.props.push({ type: 'grave', x, z, rot: 0, sx: 0.8, sz: 0.3 });
    }
  }
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.maxZ - 2, Math.round((b.w * b.d) / 900), 8, 14, 1, 'cypress');
  ctx.addBuilding(spec(b, { name: `Chapel ${b.id}`, kind: 'church', cx: b.cx, cz: r.minZ + 10, w: 14, d: 9, h: 6, roof: 'gable', color: '#5f5a55', material: 'stone' }));
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
}

function fillPromenade(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'promenade', 'paving', p.paving);
  const r = rect(b);
  const L = env.layout;
  // which edge faces the water?
  const east = L.isWater(r.maxX + 50, b.cz);
  const west = L.isWater(r.minX - 50, b.cz);
  const south = L.isWater(b.cx, r.maxZ + 50);
  const north = L.isWater(b.cx, r.minZ - 50);
  const alongX = east || west;
  const ex = east ? r.maxX - 4 : west ? r.minX + 4 : b.cx;
  const ez = south ? r.maxZ - 4 : north ? r.minZ - 4 + 8 : b.cz;
  out.props.push({ type: 'platform', x: alongX ? ex : b.cx, z: alongX ? b.cz : ez, rot: alongX ? Math.PI / 2 : 0, sx: alongX ? b.d - 4 : b.w - 4, sz: 6, color: '#c3bfb4' });
  for (let i = 0; i < Math.max(3, Math.round((alongX ? b.d : b.w) / 12)); i++) {
    const t = -((alongX ? b.d : b.w) / 2) + 6 + i * 12;
    ctx.addTree(alongX ? ex - 5 * (east ? 1 : -1) : b.cx + t, alongX ? b.cz + t : ez - 5 * (south ? 1 : -1), 6, 10, 0, 'palm');
    out.props.push({ type: 'bench', x: alongX ? ex - 2 * (east ? 1 : -1) : b.cx + t + 4, z: alongX ? b.cz + t + 4 : ez - 2 * (south ? 1 : -1), rot: alongX ? Math.PI / 2 : 0, sx: 1.8, sz: 0.5 });
  }
  if (rng.chance(0.5)) ctx.addBuilding(spec(b, { name: `Seafront Café ${b.id}`, kind: 'pavilion', cx: b.cx, cz: b.cz, w: 12, d: 9, h: 4.5, color: '#8a8c86', material: 'glass' }));
  treesIn(ctx, rng, r.minX + 3, r.maxX - 3, r.minZ + 3, r.maxZ - 3, Math.round((b.w * b.d) / 500), 5, 9, 0.1);
  ground(ctx, b, b.cx + 14, b.cz + 10, `Promenade drop — ${b.id}`);
}

function fillMarina(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'marina', 'paving', p.paving);
  const r = rect(b);
  const L = env.layout;
  const east = L.isWater(r.maxX + 50, b.cz);
  const dir = east ? 1 : L.isWater(r.minX - 50, b.cz) ? -1 : 0;
  const base = dir > 0 ? r.maxX : dir < 0 ? r.minX : b.cx;
  const n = Math.max(2, Math.floor(b.d / 22));
  for (let i = 0; i < n; i++) {
    const z = r.minZ + 11 + i * 22;
    out.props.push({ type: 'platform', x: base + dir * 22, z, rot: 0, sx: 44, sz: 2.4, color: '#9a8468' });
    for (let k = 0; k < 4; k++) if (rng.chance(0.7)) out.props.push({ type: 'boat', x: base + dir * (6 + k * 10), z: z + (rng.chance(0.5) ? 4 : -4), rot: 0, sx: 7, sz: 2.6, color: rng.pick(['#f3f1ea', '#e8e4da', '#2f3c4c', '#c8392f']) });
  }
  const club = ctx.addBuilding(spec(b, { name: `Yacht Club ${b.id}`, kind: 'pavilion', cx: b.cx, cz: b.cz, w: 16, d: 11, h: 7, roof: 'hip', color: jitter(rng.pick(p.roof), rng), material: 'plaster' }));
  parkingLot(out, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.minZ + 12);
  ground(ctx, b, club.cx + 14, club.cz + 8, `Marina drop — ${b.id}`, club.id);
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.maxZ - 2, 5, 5, 9, 0, 'palm');
}

function fillAirportBlock(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  // airport blocks are driven by the airport rectangle, not the block grid
  const rng = env.rng;
  const A = env.layout.airport;
  if (!A) return fillPaddock(ctx, b, env, out);
  addBlock(b, out, 'airport', 'turf', '#7f9456');
  const u = (b.cx - A.minX) / (A.maxX - A.minX);
  const v = (b.cz - A.minZ) / (A.maxZ - A.minZ);
  // southern strip = terminal / cargo / parking (outside the no-fly polygon), rest = airfield
  if (v > 0.78) {
    if (u < 0.2) {
      const cargo = ctx.addBuilding(spec(b, { name: `Air Cargo Terminal ${b.id}`, kind: 'warehouse', cx: b.cx, cz: b.cz, w: Math.min(b.w - 20, 80), d: Math.min(b.d - 20, 36), h: 12, color: jitter('#c9ccce', rng), material: 'metal', equipment: 4 }));
      bays(out, cargo, 's', 5);
      ground(ctx, b, cargo.cx + cargo.w / 2 + 10, cargo.cz, `Air cargo drop — ${b.id}`, cargo.id);
    } else if (u < 0.6) {
      const term = ctx.addBuilding(spec(b, { name: `Passenger Terminal ${b.id}`, kind: 'terminal', cx: b.cx, cz: b.cz - b.d / 6, w: Math.min(b.w - 10, 160), d: Math.min(b.d / 2, 40), h: 16, color: jitter('#dfe7ea', rng), material: 'glass', equipment: 6 }));
      out.props.push({ type: 'canopy', x: term.cx, z: term.cz + term.d / 2 + 4, rot: 0, sx: term.w * 0.7, sz: 7 });
      parkingLot(out, rng, b.cx - b.w / 2 + 4, b.cx + b.w / 2 - 4, term.cz + term.d / 2 + 14, b.cz + b.d / 2 - 4);
      out.utilities.push({ id: `UT-ATC-${b.id}`, kind: 'watertower', x: term.cx + term.w / 2 + 20, z: term.cz, height: 42, radius: 4 });
      ground(ctx, b, term.cx - term.w / 2 - 12, term.cz + term.d / 2 + 8, `Terminal drop — ${b.id}`, term.id);
    } else {
      for (let i = 0; i < Math.max(1, Math.floor(b.w / 60)); i++) ctx.addBuilding(spec(b, { name: `Hangar ${b.id}-${i + 1}`, kind: 'hangar', cx: b.cx - b.w / 2 + 30 + i * 60, cz: b.cz, w: 48, d: Math.min(b.d - 16, 44), h: 14, roof: 'barrel', color: jitter('#b7bcc0', rng), material: 'metal' }));
    }
    return;
  }
  // airfield: runway along X near v ≈ 0.3, taxiway, apron near terminal
  const runZ = A.minZ + (A.maxZ - A.minZ) * 0.3;
  if (Math.abs(b.cz - runZ) < b.d / 2 + 20) out.props.push({ type: 'runway', x: b.cx, z: runZ, rot: 0, sx: b.w + 12, sz: 60, color: '#4a4c4f' });
  const taxiZ = A.minZ + (A.maxZ - A.minZ) * 0.55;
  if (Math.abs(b.cz - taxiZ) < b.d / 2 + 10) out.props.push({ type: 'taxiway', x: b.cx, z: taxiZ, rot: 0, sx: b.w + 12, sz: 24, color: '#5c5e61' });
  if (v > 0.6 && u > 0.2 && u < 0.6) out.props.push({ type: 'taxiway', x: b.cx, z: b.cz, rot: 0, sx: b.w, sz: b.d, color: '#6a6c6f' });
}

function fillEmpty(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'meadow', 'lawn', rng.pick(['#7a9558', '#80985c', '#8a9a5a']));
  treesIn(ctx, rng, b.cx - b.w / 2 + 2, b.cx + b.w / 2 - 2, b.cz - b.d / 2 + 2, b.cz + b.d / 2 - 2, rng.int(2, 8), 6, 12, 0.3);
  void ctx;
}


// -------------------------------------------------------------------------------------------------
// Landmarks (one of each per city; chosen by Landmarks.ts before the fillers run)
// -------------------------------------------------------------------------------------------------

function fillLandmarkTower(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'landmarktower', 'paving', p.paving);
  const pw = Math.min(b.w - 6, 70);
  const pd = Math.min(b.d - 6, 70);
  const podium = ctx.addBuilding(spec(b, { name: `Skyline Tower Podium ${b.id}`, kind: 'podium', cx: b.cx, cz: b.cz, w: pw, d: pd, h: 3 * FLOOR_H, color: jitter(rng.pick(p.facade), rng), material: 'glass', equipment: 1, solidTop: true, keepout: { x: b.cx + pw / 2 - 9, z: b.cz + pd / 2 - 9, r: 5 } }));
  const fl = env.tall ? 60 : 46;
  const tw = Math.min(pw - 14, 30);
  const t = ctx.addBuilding(spec(b, { name: `Skyline Tower ${b.id}`, kind: 'tower', cx: b.cx, cz: b.cz, w: tw, d: tw * 0.9, h: fl * FLOOR_H, baseY: podium.baseY + podium.h, color: jitter(rng.pick(p.glass), rng), material: 'glass', equipment: 0 }));
  ctx.addBuilding(spec(b, { name: `Skyline Tower Crown ${b.id}`, kind: 'crown', cx: b.cx, cz: b.cz, w: tw * 0.6, d: tw * 0.55, h: 12, baseY: t.baseY + t.h, color: jitter(rng.pick(p.glass), rng), material: 'glass' }));
  ctx.addBuilding(spec(b, { name: `Skyline Tower Spire ${b.id}`, kind: 'spire', cx: b.cx, cz: b.cz, w: 3, d: 3, h: 26, baseY: t.baseY + t.h + 12, color: '#9aa3ab', material: 'metal', mast: true }));
  roof(ctx, b, podium, `Podium drop — ${b.id}`, { x: b.cx + pw / 2 - 9, z: b.cz + pd / 2 - 9 });
  out.props.push({ type: 'fountain', x: b.cx - pw / 2 - 2, z: b.cz, rot: 0, sx: 6, sz: 6 });
}

function fillCathedral(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  const p = pal(b, env);
  addBlock(b, out, 'cathedral', 'paving', p.paving);
  const alongX = b.w >= b.d;
  const L = Math.min(alongX ? b.w : b.d, 70) - 16;
  const nave = ctx.addBuilding(spec(b, { name: `Cathedral ${b.id}`, kind: 'church', cx: b.cx, cz: b.cz, w: alongX ? L : 22, d: alongX ? 22 : L, h: 20, roof: 'gable', color: '#5f5a55', material: 'stone' }));
  ctx.addBuilding(spec(b, { name: `Transept ${b.id}`, kind: 'church', cx: b.cx + (alongX ? L * 0.2 : 0), cz: b.cz + (alongX ? 0 : L * 0.2), w: alongX ? 14 : 40, d: alongX ? 40 : 14, h: 18, roof: 'gable', color: '#5f5a55', material: 'stone' }));
  for (const s of [-1, 1]) {
    ctx.addBuilding(spec(b, { name: `Cathedral Tower ${b.id}`, kind: 'spire', cx: alongX ? b.cx - L / 2 - 2 : b.cx + s * 9, cz: alongX ? b.cz + s * 9 : b.cz - L / 2 - 2, w: 8, d: 8, h: 42, color: '#6b6560', material: 'stone', mast: true }));
  }
  void nave;
  const r = rect(b);
  for (let i = 0; i < 6; i++) out.props.push({ type: 'bench', x: rng.range(r.minX + 4, r.maxX - 4), z: rng.range(r.minZ + 4, r.maxZ - 4), rot: rng.range(0, Math.PI), sx: 1.8, sz: 0.5 });
  treesIn(ctx, rng, r.minX + 2, r.maxX - 2, r.minZ + 2, r.maxZ - 2, 8, 6, 11, 0.4);
  ground(ctx, b, r.maxX - 10, r.maxZ - 10, `Cathedral square drop — ${b.id}`);
}

function fillTvMast(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'tvmast', 'lawn', '#7d9560');
  out.utilities.push({ id: `UT-TV-${b.id}`, kind: 'mast', x: b.cx, z: b.cz, height: env.tall ? 190 : 140, radius: 3.5 });
  ctx.addBuilding(spec(b, { name: `Transmitter Hall ${b.id}`, kind: 'shed', cx: b.cx + 16, cz: b.cz + 10, w: 14, d: 9, h: 4.5, color: '#c9ccce', material: 'concrete' }));
  fence(out, b.cx - 24, b.cx + 24, b.cz - 20, b.cz + 20);
  treesIn(ctx, rng, b.cx - b.w / 2 + 2, b.cx + b.w / 2 - 2, b.cz - b.d / 2 + 2, b.cz + b.d / 2 - 2, 10, 6, 12, 0.5);
  out.noFly.push({ id: `NFZ-MAST-${b.id}`, name: 'Broadcast mast', reason: 'Guy wires and RF hazard', shape: { type: 'circle', x: b.cx, z: b.cz, r: 45 }, maxY: 200, closable: false, active: true, source: 'auto' });
}

function fillGasometer(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const rng = env.rng;
  addBlock(b, out, 'gasometer', 'gravel', '#9c9b90');
  const r = Math.min(b.w, b.d) / 2 - 10;
  out.utilities.push({ id: `UT-GAS-${b.id}`, kind: 'tank', x: b.cx, z: b.cz, height: rng.range(26, 34), radius: Math.min(28, r) });
  ctx.addBuilding(spec(b, { name: `Gas Works ${b.id}`, kind: 'shed', cx: b.cx + b.w / 2 - 12, cz: b.cz - b.d / 2 + 10, w: 16, d: 10, h: 5, color: '#b7bcc0', material: 'corrugated' }));
  fence(out, b.cx - b.w / 2 + 0.5, b.cx + b.w / 2 - 0.5, b.cz - b.d / 2 + 0.5, b.cz + b.d / 2 - 0.5);
}

// -------------------------------------------------------------------------------------------------
// Depot (PRD: local resource — parcel hand-off bays + scarce charging pads)
// -------------------------------------------------------------------------------------------------

export interface DepotBuild {
  building: BuildingData;
  pads: { x: number; z: number }[];
  handoff: { x: number; z: number }[];
  apron: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function fillDepot(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): DepotBuild {
  const rng = env.rng;
  addBlock(b, out, 'depot', 'gravel', '#a4a49e');
  out.depotBlocks.push(b);
  const r = rect(b);
  const side = frontSide(b); // docks face the busiest street
  const alongX = side === 'n' || side === 's';
  const bw = Math.min(alongX ? b.w - 16 : b.w - 44, 64);
  const bd = Math.min(alongX ? b.d - 44 : b.d - 16, 36);
  // building sits at the back, apron (pads) in front of the docks
  const cx = alongX ? b.cx : side === 'e' ? r.minX + bw / 2 + 6 : r.maxX - bw / 2 - 6;
  const cz = alongX ? (side === 's' ? r.minZ + bd / 2 + 6 : r.maxZ - bd / 2 - 6) : b.cz;
  const building = ctx.addBuilding(spec(b, { name: `Parcel Depot ${b.id}`, kind: 'distribution', cx, cz, w: bw, d: bd, h: 12, color: jitter(rng.pick(WAREHOUSE), rng), material: 'metal', equipment: 4, solar: true }));
  bays(out, building, side, Math.max(3, Math.floor((alongX ? bw : bd) / 10)));
  // apron in front of the docks
  const gap = 10;
  const apron = alongX
    ? { minX: cx - bw / 2 - 2, maxX: cx + bw / 2 + 2, minZ: side === 's' ? cz + bd / 2 + gap : cz - bd / 2 - gap - 24, maxZ: side === 's' ? cz + bd / 2 + gap + 24 : cz - bd / 2 - gap }
    : { minX: side === 'e' ? cx + bw / 2 + gap : cx - bw / 2 - gap - 24, maxX: side === 'e' ? cx + bw / 2 + gap + 24 : cx - bw / 2 - gap, minZ: cz - bd / 2 - 2, maxZ: cz + bd / 2 + 2 };
  const pads: { x: number; z: number }[] = [];
  const handoff: { x: number; z: number }[] = [];
  const n = env.depotPads?.get(b.id) ?? env.padsPerDepot;
  // a hub with more than 3 pads packs them to fit the apron; 1-3 pads keep the legacy 12 m pitch
  const pitch = n > 3 ? Math.min(12, ((alongX ? bw : bd) + 4 - 8) / n) : 12;
  for (let i = 0; i < n; i++) {
    const t = (i - (n - 1) / 2) * pitch;
    pads.push(alongX ? { x: cx + t, z: (apron.minZ + apron.maxZ) / 2 + (side === 's' ? 4 : -4) } : { x: (apron.minX + apron.maxX) / 2 + (side === 'e' ? 4 : -4), z: cz + t });
  }
  // hand-off bays: between docks and pads, two of them
  for (const t of [-(alongX ? bw : bd) / 4, (alongX ? bw : bd) / 4]) {
    handoff.push(alongX ? { x: cx + t, z: side === 's' ? cz + bd / 2 + 5 : cz - bd / 2 - 5 } : { x: side === 'e' ? cx + bw / 2 + 5 : cx - bw / 2 - 5, z: cz + t });
  }
  for (const h of handoff) ctx.keepout(h.x, h.z, 6);
  ctx.keepout((apron.minX + apron.maxX) / 2, (apron.minZ + apron.maxZ) / 2, Math.max(apron.maxX - apron.minX, apron.maxZ - apron.minZ) / 2 + 6);
  // ops office + parking elsewhere on the lot
  const ox = alongX ? r.maxX - 10 : cx;
  const oz = alongX ? cz : r.maxZ - 8;
  if (ctx.clear(ox, oz, 8)) ctx.addBuilding(spec(b, { name: `Depot Operations ${b.id}`, kind: 'office', cx: ox, cz: oz, w: 14, d: 9, h: 5, color: '#c7c8c4', material: 'concrete', equipment: 1 }));
  // trailers at the docks, a container row and staff parking fill the rest of the yard
  for (let t = 0; t < Math.floor((alongX ? bw : bd) / 10); t++) {
    if (!rng.chance(0.5)) continue;
    const off = -(alongX ? bw : bd) / 2 + 5 + t * 10;
    const px = alongX ? cx + off : side === 'e' ? cx + bw / 2 + 5 : cx - bw / 2 - 5;
    const pz = alongX ? (side === 's' ? cz + bd / 2 + 5 : cz - bd / 2 - 5) : cz + off;
    if (apron.minX - 4 < px && px < apron.maxX + 4 && apron.minZ - 4 < pz && pz < apron.maxZ + 4) continue;
    out.parking.push({ x: px, z: pz, rot: alongX ? 0 : Math.PI / 2, w: 3.4, d: 10 });
  }
  const farX = alongX ? r.minX + 6 : side === 'e' ? r.minX + 6 : r.maxX - 6;
  for (let c = 0; c < Math.floor((b.d - 20) / 3.2) && c < 14; c++) {
    if (rng.chance(0.3)) continue;
    const czc = r.minZ + 10 + c * 3.2;
    if (Math.abs(czc - cz) < bd / 2 + 6 && Math.abs(farX - cx) < bw / 2 + 6) continue;
    if (!ctx.clear(farX, czc, 4)) continue;
    out.containers.push({ x: farX, z: czc, rot: 0, stack: rng.int(1, 2), color: rng.pick(CONTAINER) });
  }
  if (alongX) parkingLot(out, rng, r.minX + 2, Math.min(r.maxX - 2, r.minX + 46), side === 's' ? r.minZ + 2 : r.maxZ - 14, side === 's' ? r.minZ + 14 : r.maxZ - 2);
  fence(out, r.minX + 0.5, r.maxX - 0.5, r.minZ + 0.5, r.maxZ - 0.5);
  return { building, pads, handoff, apron };
}

// -------------------------------------------------------------------------------------------------
// Dispatcher
// -------------------------------------------------------------------------------------------------

export const FILLERS: Record<string, Filler> = {
  houses: (c, b, e, o) => fillHouses(c, b, e, o, false),
  bighouses: (c, b, e, o) => fillHouses(c, b, e, o, true),
  duplex: fillDuplex,
  rows: fillRows,
  slabs: fillSlabs,
  perimeter: (c, b, e, o) => fillPerimeter(c, b, e, o, false),
  officeblock: (c, b, e, o) => fillPerimeter(c, b, e, o, true),
  towerspark: fillTowersPark,
  pocketpark: fillPocketPark,
  school: fillSchool,
  church: fillChurch,
  cornershop: fillCornerShop,
  gasstation: fillGasStation,
  supermarket: fillSupermarket,
  sportsfield: fillSportsField,
  paddock: fillPaddock,
  solarfarm: fillSolarFarm,
  fields: fillFields,
  farmstead: fillFarmstead,
  barns: fillBarns,
  tower: (c, b, e, o) => fillTower(c, b, e, o, false),
  towerpair: (c, b, e, o) => fillTower(c, b, e, o, true),
  officemid: fillOfficeMid,
  strip: fillStrip,
  plaza: fillPlaza,
  hotel: fillHotel,
  parkinggarage: fillParkingGarage,
  mall: fillMall,
  civic: fillCivic,
  construction: fillConstruction,
  warehouses: fillWarehouses,
  distribution: fillWarehouses,
  factory: fillFactory,
  sheds: fillSheds,
  tanks: fillTanks,
  silos: fillSilos,
  truckdepot: fillTruckDepot,
  substation: fillSubstation,
  watertower: fillWaterTower,
  containeryard: fillContainerYard,
  quay: fillQuay,
  park: fillPark,
  campus: fillCampus,
  hospital: fillHospital,
  stadium: fillStadium,
  cemetery: fillCemetery,
  promenade: fillPromenade,
  marina: fillMarina,
  airport: fillAirportBlock,
  landmarktower: fillLandmarkTower,
  cathedral: fillCathedral,
  tvmast: fillTvMast,
  gasometer: fillGasometer,
  empty: fillEmpty,
};

export function fillBlock(ctx: BuildContext, b: LayoutBlock, env: FillEnv, out: FillOut): void {
  const kind = chooseBlockKind(b, env);
  b.kind = kind;
  const counts = env.kindCounts.get(b.districtId) ?? env.kindCounts.set(b.districtId, new Map()).get(b.districtId)!;
  counts.set(kind, (counts.get(kind) ?? 0) + 1);
  const f = FILLERS[kind];
  if (!f) {
    fillEmpty(ctx, b, env, out);
    return;
  }
  f(ctx, b, env, out);
}

/** Airport no-fly polygon (chamfered rectangle over the airfield; the terminal strip stays open). */
export function airportNoFly(layout: CityLayout): NoFlyZone | null {
  const A = layout.airport;
  if (!A) return null;
  const ch = 200;
  const maxZ = A.minZ + (A.maxZ - A.minZ) * 0.76;
  const pts = [
    { x: A.minX + ch, z: A.minZ - 150 },
    { x: A.maxX - ch, z: A.minZ - 150 },
    { x: A.maxX + 150, z: A.minZ + ch },
    { x: A.maxX + 150, z: maxZ },
    { x: A.minX - 150, z: maxZ },
    { x: A.minX - 150, z: A.minZ + ch },
  ];
  return { id: 'NFZ-AIRPORT', name: 'Airport control zone', reason: 'Controlled airspace — manned aviation', shape: polygonShape(pts), maxY: 300, closable: false, active: true, source: 'auto' };
}

export type { CraneData, UtilityStructure, ContainerStack, ParkingSpace, PropData, LoadingBay };
