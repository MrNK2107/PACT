import { featuresForSize, type LayoutFeatures } from './features';
import { Noise2D } from './noise';
import { Rng } from './rng';
import type { CoastData, DistrictData, DistrictKind, JunctionData, RailData, RiverData, RoadData, RoadKind, StationData, ZoneType } from './types';

/**
 * Macro layout of the city: water, airport, road hierarchy, districts (super-blocks between
 * arterials) and the local street grid inside each district. Pure geometry — no buildings yet.
 * Everything is a deterministic function of (seed, size).
 */

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SuperBlock extends DistrictData {
  /** Centre-lines of the bounding major roads. */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Buildable rectangle (inside the bounding road half-widths). */
  inner: Rect;
  waterFrac: number;
}

export interface LayoutBlock {
  id: string;
  districtId: string;
  district: DistrictKind;
  zone: ZoneType;
  /** Block kind chosen by the layout (consumed by the fillers). */
  kind: string;
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Width of the street along each edge (0 = no street, e.g. a park edge or water). */
  streets: { n: number; s: number; e: number; w: number };
  nearWater: boolean;
  centrality: number;
}

export interface CityLayout {
  size: number;
  half: number;
  centre: { x: number; z: number };
  centres: { x: number; z: number; w: number }[];
  coast: CoastData | null;
  rivers: RiverData[];
  airport: Rect | null;
  port: Rect | null;
  roads: RoadData[];
  junctions: JunctionData[];
  rails: RailData[];
  stations: StationData[];
  districts: SuperBlock[];
  blocks: LayoutBlock[];
  isWater: (x: number, z: number) => boolean;
  shoreX: (z: number) => number;
  riverX: (z: number) => number | null;
  riverWidth: (z: number) => number;
  waterLevel: number;
}

const ROAD: Record<RoadKind, { width: number; lanes: number; bridgeMax: number }> = {
  motorway: { width: 30, lanes: 6, bridgeMax: 420 },
  arterial: { width: 18, lanes: 4, bridgeMax: 260 },
  collector: { width: 12, lanes: 2, bridgeMax: 0 },
  local: { width: 8, lanes: 2, bridgeMax: 0 },
  service: { width: 6, lanes: 1, bridgeMax: 0 },
};

const STREET_NAMES = [
  'Maple', 'Oak', 'Elm', 'Cedar', 'Birch', 'Willow', 'Linden', 'Juniper', 'Harbour', 'Mill', 'Station', 'Market', 'Church', 'Bridge', 'Park', 'Hill',
  'River', 'Lake', 'Castle', 'Victoria', 'Albert', 'King', 'Queen', 'Union', 'Liberty', 'Commerce', 'Foundry', 'Granary', 'Tanner', 'Cooper', 'Mason',
  'Baker', 'Weaver', 'Orchard', 'Meadow', 'Garden', 'Spring', 'Summer', 'Chapel', 'College', 'Hospital', 'Dock', 'Quay', 'Wharf', 'Canal', 'Ferry',
];
const SUFFIX = ['St', 'Rd', 'Ln', 'Way', 'Dr', 'Cl', 'Pl', 'Cres'];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
function smooth(t: number): number {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Piecewise-linear lookup over samples ordered by z (uniform spacing). */
function sampler(points: { x: number; z: number }[], z0: number, dz: number): (z: number) => number {
  const n = points.length;
  return (z: number) => {
    const t = (z - z0) / dz;
    if (t <= 0) return points[0].x;
    if (t >= n - 1) return points[n - 1].x;
    const i = Math.floor(t);
    return lerp(points[i].x, points[i + 1].x, t - i);
  };
}

export function generateLayout(seed: number, size: number, f: LayoutFeatures = featuresForSize(size)): CityLayout {
  const rng = new Rng(seed ^ 0x5bd1e995);
  const noise = new Noise2D(seed);
  const noise2 = new Noise2D(seed + 101);
  const half = size / 2;
  const S = size / 12000; // scale factor relative to the reference 12 km city

  // ---- centres -----------------------------------------------------------------------------------------
  const centre = { x: rng.range(-0.08, 0.04) * size, z: rng.range(-0.06, 0.06) * size };
  const centres: { x: number; z: number; w: number }[] = [];
  const nSecondary = f.secondaryCentres;
  for (let i = 0; i < nSecondary; i++) {
    const ang = rng.range(0, Math.PI * 2);
    const r = rng.range(0.22, 0.34) * size;
    centres.push({ x: centre.x + Math.cos(ang) * r, z: centre.z + Math.sin(ang) * r, w: rng.range(0.55, 0.8) });
  }

  // ---- water -------------------------------------------------------------------------------------------
  const waterLevel = -0.9;
  const hasSea = f.water === 'coast_river' || f.water === 'coast';
  const hasRiver = f.water === 'coast_river' || f.water === 'river';
  const SAMPLE = 25;
  const nS = Math.ceil(size / SAMPLE) + 1;
  const shorePts: { x: number; z: number }[] = [];
  // without a sea the shoreline is infinitely far east, so every "x > shoreX" test is false
  let shoreX: (z: number) => number = () => Infinity;
  if (hasSea) {
    const bayDepth = rng.range(500, 900) * S;
    const shoreBase = half * rng.range(0.68, 0.76);
    for (let i = 0; i < nS; i++) {
      const z = -half + i * SAMPLE;
      const u = (z + half) / size;
      const x = shoreBase - bayDepth * Math.sin(u * Math.PI) + (noise.fbm(0, z, 1400 * S, 4) - 0.5) * 900 * S + (noise2.fbm(3, z, 260, 3) - 0.5) * 140;
      shorePts.push({ x, z });
    }
    shoreX = sampler(shorePts, -half, SAMPLE);
  }
  const coast: CoastData | null = hasSea ? { shore: shorePts, waterY: waterLevel } : null;

  // river: enters from the north, meanders south then bends east into the bay
  const riverPts: { x: number; z: number }[] = [];
  const widths: number[] = [];
  const rx0 = hasRiver ? centre.x - rng.range(0.14, 0.26) * size : 0;
  const bend = hasRiver ? rng.range(0.05, 0.3) : 0;
  let riverEndZ = half;
  for (let i = 0; hasRiver && i < nS; i++) {
    const z = -half + i * SAMPLE;
    const u = (z + half) / size;
    const meander = Math.sin(u * Math.PI * 2.4 + seed % 7) * 520 * S + (noise2.fbm(z, 11, 900 * S, 4) - 0.5) * 900 * S;
    const towardsSea = smooth((u - bend) / (1 - bend - 0.08));
    const x = hasSea ? lerp(rx0 + meander, shoreX(z) + 200, towardsSea) : rx0 + meander;
    const w = 60 * S + 40 * S * u + (noise.fbm(z, 5, 400, 2) - 0.5) * 30;
    riverPts.push({ x, z });
    widths.push(Math.max(36, w));
    if (x >= shoreX(z) - 5) {
      riverEndZ = z;
      break;
    }
  }
  const riverXFn = hasRiver ? sampler(riverPts, -half, SAMPLE) : () => 0;
  const riverX = (z: number) => (hasRiver && z <= riverEndZ ? riverXFn(z) : null);
  const riverWidth = (z: number) => {
    if (!hasRiver) return 0;
    const t = (z + half) / SAMPLE;
    const i = Math.max(0, Math.min(widths.length - 1, Math.floor(t)));
    return widths[i];
  };
  const rivers: RiverData[] = hasRiver ? [{ id: 'RIV-01', name: 'River', points: riverPts, width: 80 * S, waterY: waterLevel }] : [];
  const isWater = (x: number, z: number): boolean => {
    if (x > shoreX(z)) return true;
    const r = riverX(z);
    return r !== null && Math.abs(x - r) < riverWidth(z) / 2;
  };

  // ---- airport / port -----------------------------------------------------------------------------------
  let airport: Rect | null = null;
  if (f.airport) {
    const w = 2700 * S;
    const d = 1700 * S;
    const minX = -half + 0.14 * size;
    const minZ = half - 0.1 * size - d;
    airport = { minX, maxX: minX + w, minZ, maxZ: minZ + d };
  }
  let port: Rect | null = null;
  if (f.port && hasSea) {
    // on the bay, south of the river mouth
    const z0 = Math.min(half - 1500 * S, riverEndZ + 500 * S);
    const z1 = Math.min(half - 300, z0 + 1600 * S);
    let sx = Infinity;
    for (let z = z0; z <= z1; z += 50) sx = Math.min(sx, shoreX(z));
    port = { minX: sx - 1300 * S, maxX: sx + 10, minZ: z0, maxZ: z1 };
  }

  // ---- major roads ---------------------------------------------------------------------------------------
  const roads: RoadData[] = [];
  let rn = 0;
  const roadId = () => `R-${String(++rn).padStart(5, '0')}`;
  const inRect = (r: Rect | null, x: number, z: number) => !!r && x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ;

  /** 0 = land, 1 = water (bridgeable), 2 = hard cut. */
  const classify = (x: number, z: number): 0 | 1 | 2 => {
    if (inRect(airport, x, z)) return 2;
    if (x > shoreX(z)) return 1;
    const r = riverX(z);
    if (r !== null && Math.abs(x - r) < riverWidth(z) / 2 + 6) return 1;
    return 0;
  };

  /** Split a straight road wherever it meets water / the airport; short water runs become bridges. */
  const addRoad = (name: string, kind: RoadKind, dir: 'EW' | 'NS', c: number, a: number, b: number, widthOverride?: number) => {
    const spec = ROAD[kind];
    const width = widthOverride ?? spec.width;
    const step = 4;
    const n = Math.max(1, Math.ceil((b - a) / step));
    const cls: number[] = new Array(n + 1);
    for (let k = 0; k <= n; k++) {
      const t = a + ((b - a) * k) / n;
      cls[k] = dir === 'EW' ? classify(t, c) : classify(c, t);
    }
    // runs
    let segStart: number | null = null;
    let bridges: { a: number; b: number }[] = [];
    const flush = (end: number) => {
      if (segStart !== null && end - segStart >= 40) {
        roads.push({ id: roadId(), name, kind, dir, c, a: segStart, b: end, width, lanes: spec.lanes, bridges: bridges.length ? bridges : undefined });
      }
      segStart = null;
      bridges = [];
    };
    let k = 0;
    while (k <= n) {
      const t = a + ((b - a) * k) / n;
      if (cls[k] === 0) {
        if (segStart === null) segStart = t;
        k++;
        continue;
      }
      // run of non-land
      const runCls = cls[k];
      let k2 = k;
      while (k2 <= n && cls[k2] === runCls) k2++;
      const t2 = a + ((b - a) * Math.min(k2, n)) / n;
      const len = t2 - t;
      const seaRun = dir === 'EW' ? t2 > shoreX(c) - 1 : false;
      if (runCls === 1 && len <= spec.bridgeMax && segStart !== null && k2 <= n && !seaRun) {
        bridges.push({ a: t - 6, b: t2 + 6 });
        k = k2;
        continue;
      }
      flush(t - (runCls === 1 ? 30 : 10));
      k = k2;
      segStart = null;
    }
    flush(b);
  };

  // motorway ring + two through routes
  let shoreMin = Infinity;
  for (const p of shorePts) shoreMin = Math.min(shoreMin, p.x);
  const ringW = -half + 0.09 * size;
  const ringE = Math.min(half - 0.09 * size, shoreMin - 420 * S);
  const ringN = -half + 0.09 * size;
  const ringS = half - 0.09 * size;
  if (f.motorwayRing) {
    addRoad('M1 Western Ring', 'motorway', 'NS', ringW, ringN, ringS);
    addRoad('M1 Coastal Motorway', 'motorway', 'NS', ringE, ringN, ringS);
    addRoad('M2 Northern Ring', 'motorway', 'EW', ringN, ringW, ringE);
    addRoad('M2 Southern Ring', 'motorway', 'EW', ringS, ringW, ringE);
    addRoad('M3 Cross-City', 'motorway', 'NS', centre.x + rng.range(0.1, 0.16) * size, ringN, ringS);
    addRoad('M4 Riverside Expressway', 'motorway', 'EW', centre.z - rng.range(0.1, 0.15) * size, ringW, ringE);
  }
  const majorNS: number[] = [];
  const majorEW: number[] = [];
  for (const r of roads) (r.dir === 'NS' ? majorNS : majorEW).push(r.c);

  // arterials: jittered spacing, finer near the centre
  const arterial = (dir: 'EW' | 'NS') => {
    const list = dir === 'NS' ? majorNS : majorEW;
    let c = -half + rng.range(260, 420);
    let i = 0;
    while (c < half - 220) {
      const d = dir === 'NS' ? Math.abs(c - centre.x) : Math.abs(c - centre.z);
      const near = Math.exp(-d / (2600 * S));
      const tooClose = list.some((m) => Math.abs(m - c) < 170);
      if (!tooClose) {
        list.push(c);
        const name = dir === 'NS' ? `${ordinal(++i)} Avenue` : `${rng.pick(STREET_NAMES)} Street`;
        const width = near > 0.55 ? 22 : 18;
        addRoad(name, 'arterial', dir, c, -half + 60, half - 60, width);
      }
      c += rng.range(360, 640) * lerp(1, 0.78, near);
    }
  };
  arterial('NS');
  arterial('EW');
  majorNS.sort((a, b) => a - b);
  majorEW.sort((a, b) => a - b);

  // ---- rail ----------------------------------------------------------------------------------------------
  const rails: RailData[] = [];
  const stations: StationData[] = [];
  let railZ: number | null = null;
  if (f.rail) {
    railZ = centre.z + rng.range(0.03, 0.07) * size;
    // keep clear of arterials
    while (majorEW.some((m) => Math.abs(m - railZ!) < 60)) railZ += 40;
    const pts: { a: number; b: number }[] = [];
    let start: number | null = null;
    for (let x = -half; x <= half; x += 8) {
      const land = classify(x, railZ) === 0 || (x <= shoreX(railZ) && classify(x, railZ) === 1);
      const sea = x > shoreX(railZ) - 30;
      if (land && !sea) {
        if (start === null) start = x;
      } else if (start !== null) {
        pts.push({ a: start, b: x });
        start = null;
      }
    }
    if (start !== null) pts.push({ a: start, b: half });
    for (const seg of pts) {
      // river crossings become rail bridges
      const bridges: { a: number; b: number }[] = [];
      for (let x = seg.a; x <= seg.b; x += 8) {
        const r = riverX(railZ);
        if (r !== null && Math.abs(x - r) < riverWidth(railZ) / 2 + 6) {
          const last = bridges[bridges.length - 1];
          if (last && x - last.b < 20) last.b = x + 8;
          else bridges.push({ a: x - 8, b: x + 8 });
        }
      }
      rails.push({ id: `RL-${String(rails.length + 1).padStart(2, '0')}`, dir: 'EW', c: railZ, a: seg.a, b: seg.b, width: 14, bridges: bridges.length ? bridges : undefined });
    }
    // central + a few suburban stations
    const sx = [centre.x + rng.range(-200, 200), centre.x - 0.2 * size, centre.x + 0.19 * size, -half + 0.11 * size];
    sx.forEach((x, i) => {
      if (classify(x, railZ!) !== 0) return;
      if (airport && x > airport.minX - 300 && x < airport.maxX + 300 && railZ! > airport.minZ - 300) return;
      stations.push({ id: `ST-${String(i + 1).padStart(2, '0')}`, name: i === 0 ? 'Central Station' : `${rng.pick(STREET_NAMES)} Station`, x, z: railZ!, length: i === 0 ? 220 : 140, dir: 'EW' });
    });
  }

  // ---- districts (super-blocks) ---------------------------------------------------------------------------
  const districts: SuperBlock[] = [];
  const xs = [-half, ...majorNS, half];
  const zs = [-half, ...majorEW, half];
  const roadWidthAt = (dir: 'EW' | 'NS', c: number): number => {
    const r = roads.find((q) => q.dir === dir && Math.abs(q.c - c) < 1e-6);
    return r ? r.width + (r.kind === 'motorway' ? 28 : 0) : 0;
  };
  const dCentre = (x: number, z: number) => Math.hypot(x - centre.x, z - centre.z);
  const centrality = (x: number, z: number) => {
    let c = Math.exp(-dCentre(x, z) / (2300 * S));
    for (const s of centres) c = Math.max(c, s.w * Math.exp(-Math.hypot(x - s.x, z - s.z) / (900 * S)));
    return c;
  };
  const specials: { kind: DistrictKind; count: number }[] = [
    { kind: 'hospital', count: f.specials.hospital },
    { kind: 'campus', count: f.specials.campus },
    { kind: 'stadium', count: f.specials.stadium },
    { kind: 'cemetery', count: f.specials.cemetery },
  ];
  let dn = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < zs.length - 1; j++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const z0 = zs[j];
      const z1 = zs[j + 1];
      const hw0 = i === 0 ? 0 : roadWidthAt('NS', x0) / 2;
      const hw1 = i === xs.length - 2 ? 0 : roadWidthAt('NS', x1) / 2;
      const hd0 = j === 0 ? 0 : roadWidthAt('EW', z0) / 2;
      const hd1 = j === zs.length - 2 ? 0 : roadWidthAt('EW', z1) / 2;
      const inner: Rect = { minX: x0 + hw0 + 4, maxX: x1 - hw1 - 4, minZ: z0 + hd0 + 4, maxZ: z1 - hd1 - 4 };
      if (inner.maxX - inner.minX < 80 || inner.maxZ - inner.minZ < 80) continue;
      const cx = (inner.minX + inner.maxX) / 2;
      const cz = (inner.minZ + inner.maxZ) / 2;
      let wet = 0;
      let total = 0;
      for (let a = 0; a < 7; a++) {
        for (let b = 0; b < 7; b++) {
          total++;
          if (isWater(lerp(inner.minX, inner.maxX, (a + 0.5) / 7), lerp(inner.minZ, inner.maxZ, (b + 0.5) / 7))) wet++;
        }
      }
      const waterFrac = wet / total;
      const cen = centrality(cx, cz);
      const n = noise.fbm(cx, cz, 2100 * S, 3);
      const nInd = noise2.fbm(cx + 5000, cz - 7000, 2600 * S, 3);
      const edge = Math.max(Math.abs(cx), Math.abs(cz)) / half; // 0 centre … 1 map edge
      let kind: DistrictKind;
      const bCbd = f.districtBias.cbd ?? 1;
      const bInd = f.districtBias.industrial ?? 1;
      const bPark = f.districtBias.park ?? 1;
      const bSub = f.districtBias.suburb ?? 1;
      const bFarm = f.districtBias.farmland;
      const nFarm = bFarm !== undefined ? noise2.fbm(cx - 3000, cz + 4000, 1800 * S, 3) : 0;
      const cenR = cen / bSub; // >1 pushes the residential ladder towards its outer kinds
      const airportHit = airport && !(inner.maxX < airport.minX || inner.minX > airport.maxX || inner.maxZ < airport.minZ || inner.minZ > airport.maxZ);
      const portHit = port && cx > port.minX && cx < port.maxX && cz > port.minZ && cz < port.maxZ;
      const railNear = railZ !== null && Math.abs(cz - railZ) < 700 * S;
      if (waterFrac > 0.8) kind = 'water';
      else if (airportHit) kind = 'airport';
      else if (portHit && waterFrac < 0.6) kind = 'port';
      else if (waterFrac > 0.22) kind = 'waterfront';
      else if (dCentre(cx, cz) < 760 * S * bCbd) kind = 'cbd';
      else if (cen * bCbd > 0.62) kind = 'commercial';
      else if (n * bPark > 0.79 && cen < 0.6) kind = 'park';
      else if ((nInd + (railNear ? 0.16 : 0) + (edge > 0.72 ? 0.12 : 0)) * bInd - cen * 0.9 > 0.62 && cen < 0.4) kind = nInd > 0.7 ? 'logistics' : 'industrial';
      else if (bFarm !== undefined && cen < 0.3 && nFarm * bFarm > 0.42) kind = 'farmland';
      else if (cenR > 0.44) kind = 'mixed';
      else if (cenR > 0.3) kind = 'apartments';
      else if (cenR > 0.2) kind = 'townhouses';
      else if (cenR > 0.1 || edge < 0.55) kind = 'houses';
      else kind = 'suburb';
      const id = `DIST-${String(++dn).padStart(3, '0')}`;
      districts.push({ id, kind, name: '', x0, x1, z0, z1, inner, minX: inner.minX, maxX: inner.maxX, minZ: inner.minZ, maxZ: inner.maxZ, centrality: cen, waterFrac });
    }
  }
  // force a large park next to the CBD (the city's "central park"), then sprinkle civic specials
  {
    const cands = districts.filter((d) => (d.kind === 'mixed' || d.kind === 'commercial' || d.kind === 'apartments') && d.waterFrac === 0);
    cands.sort((a, b) => dCentre((a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2) - dCentre((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2));
    if (cands.length) cands[0].kind = 'park';
    for (const sp of specials) {
      const pool = districts.filter((d) => ['mixed', 'apartments', 'townhouses', 'houses'].includes(d.kind) && d.waterFrac === 0);
      for (let k = 0; k < sp.count && pool.length; k++) {
        const pick = pool.splice(rng.int(0, pool.length - 1), 1)[0];
        pick.kind = sp.kind;
      }
    }
  }
  const DISTRICT_NAMES: Record<DistrictKind, string> = {
    cbd: 'Central Business District',
    commercial: 'Commercial Quarter',
    mixed: 'Mixed-use Quarter',
    apartments: 'Apartment Quarter',
    townhouses: 'Terraced Quarter',
    houses: 'Residential Neighbourhood',
    suburb: 'Outer Suburb',
    industrial: 'Industrial Estate',
    logistics: 'Logistics Park',
    port: 'Port',
    park: 'City Park',
    campus: 'University Campus',
    hospital: 'Hospital Quarter',
    stadium: 'Stadium Precinct',
    airport: 'Airport',
    cemetery: 'Cemetery',
    waterfront: 'Waterfront',
    farmland: 'Farmland',
    water: 'Water',
  };
  const nameCount = new Map<DistrictKind, number>();
  for (const d of districts) {
    const k = (nameCount.get(d.kind) ?? 0) + 1;
    nameCount.set(d.kind, k);
    d.name = `${DISTRICT_NAMES[d.kind]} ${k}`;
  }

  // ---- local streets and blocks ---------------------------------------------------------------------------
  const SPACING: Partial<Record<DistrictKind, [number, number, number]>> = {
    // [min spacing, max spacing, street width]
    cbd: [78, 108, 12],
    commercial: [90, 130, 10],
    mixed: [95, 140, 10],
    apartments: [105, 150, 10],
    townhouses: [85, 125, 8],
    houses: [105, 160, 8],
    suburb: [120, 185, 8],
    industrial: [170, 290, 12],
    logistics: [190, 320, 12],
    port: [220, 360, 12],
    waterfront: [110, 170, 8],
    campus: [150, 240, 8],
    hospital: [170, 260, 10],
    stadium: [220, 400, 12],
    cemetery: [240, 400, 6],
    farmland: [260, 420, 6],
  };
  const blocks: LayoutBlock[] = [];
  let bn = 0;
  const zoneOf = (k: DistrictKind): ZoneType =>
    k === 'cbd' || k === 'commercial' ? 'commercial' : k === 'industrial' || k === 'logistics' || k === 'port' ? 'industrial' : k === 'park' || k === 'cemetery' || k === 'waterfront' ? 'park' : k === 'farmland' ? 'rural' : k === 'campus' || k === 'hospital' || k === 'stadium' ? 'civic' : k === 'airport' ? 'transport' : k === 'water' ? 'water' : 'residential';

  const localName = () => `${rng.pick(STREET_NAMES)} ${rng.pick(SUFFIX)}`;

  for (const d of districts) {
    if (d.kind === 'water') continue;
    const spec = SPACING[d.kind];
    const inner = d.inner;
    const W = inner.maxX - inner.minX;
    const D = inner.maxZ - inner.minZ;
    // positions of internal streets (centre-lines)
    const cuts = (len: number, lo: number): number[] => {
      if (!spec) return [];
      const out: number[] = [];
      let p = lo + rng.range(spec[0], spec[1]);
      while (p < lo + len - spec[0] * 0.75) {
        out.push(p);
        p += rng.range(spec[0], spec[1]);
      }
      return out;
    };
    const sw = spec ? spec[2] : 0;
    const vx = d.kind === 'park' || d.kind === 'airport' ? [] : cuts(W, inner.minX);
    const vz = d.kind === 'park' || d.kind === 'airport' ? [] : cuts(D, inner.minZ);
    // a collector through the middle of large districts
    const collectorX = vx.length >= 3 ? vx[Math.floor(vx.length / 2)] : null;
    const collectorZ = vz.length >= 3 ? vz[Math.floor(vz.length / 2)] : null;
    const streetW = (c: number | null, v: number) => (c !== null && c === v ? Math.max(sw, 12) : sw);
    for (const x of vx) addRoad(localName(), collectorX === x ? 'collector' : 'local', 'NS', x, inner.minZ - 4, inner.maxZ + 4, streetW(collectorX, x));
    for (const z of vz) addRoad(localName(), collectorZ === z ? 'collector' : 'local', 'EW', z, inner.minX - 4, inner.maxX + 4, streetW(collectorZ, z));

    const bx = [inner.minX - 4, ...vx, inner.maxX + 4];
    const bz = [inner.minZ - 4, ...vz, inner.maxZ + 4];
    for (let i = 0; i < bx.length - 1; i++) {
      for (let j = 0; j < bz.length - 1; j++) {
        const wW = i === 0 ? 0 : streetW(collectorX, bx[i]);
        const wE = i === bx.length - 2 ? 0 : streetW(collectorX, bx[i + 1]);
        const wN = j === 0 ? 0 : streetW(collectorZ, bz[j]);
        const wS = j === bz.length - 2 ? 0 : streetW(collectorZ, bz[j + 1]);
        const minX = bx[i] + (i === 0 ? 4 : wW / 2 + 2);
        const maxX = bx[i + 1] - (i === bx.length - 2 ? 4 : wE / 2 + 2);
        const minZ = bz[j] + (j === 0 ? 4 : wN / 2 + 2);
        const maxZ = bz[j + 1] - (j === bz.length - 2 ? 4 : wS / 2 + 2);
        const w = maxX - minX;
        const dd = maxZ - minZ;
        if (w < 24 || dd < 24) continue;
        const cx = (minX + maxX) / 2;
        const cz = (minZ + maxZ) / 2;
        // water test
        let wet = 0;
        let near = false;
        for (let a = 0; a < 5; a++) {
          for (let b = 0; b < 5; b++) {
            const px = lerp(minX, maxX, (a + 0.5) / 5);
            const pz = lerp(minZ, maxZ, (b + 0.5) / 5);
            if (isWater(px, pz)) wet++;
            if (!near && (isWater(px + 60, pz) || isWater(px - 60, pz) || isWater(px, pz + 60) || isWater(px, pz - 60))) near = true;
          }
        }
        if (wet > 0) continue;
        if (railZ !== null && minZ < railZ + 12 && maxZ > railZ - 12) {
          // split the block by the rail corridor
          const parts: [number, number][] = [];
          if (railZ - 14 - minZ > 24) parts.push([minZ, railZ - 14]);
          if (maxZ - (railZ + 14) > 24) parts.push([railZ + 14, maxZ]);
          for (const [a, b] of parts) {
            blocks.push({ id: `BK-${String(++bn).padStart(5, '0')}`, districtId: d.id, district: d.kind, zone: zoneOf(d.kind), kind: '', cx, cz: (a + b) / 2, w, d: b - a, streets: { n: wN, s: wS, e: wE, w: wW }, nearWater: near, centrality: d.centrality });
          }
          continue;
        }
        blocks.push({ id: `BK-${String(++bn).padStart(5, '0')}`, districtId: d.id, district: d.kind, zone: zoneOf(d.kind), kind: '', cx, cz, w, d: dd, streets: { n: wN, s: wS, e: wE, w: wW }, nearWater: near, centrality: d.centrality });
      }
    }
  }

  // ---- junctions -------------------------------------------------------------------------------------------
  const junctions: JunctionData[] = [];
  const ew = roads.filter((r) => r.dir === 'EW').sort((p, q) => p.c - q.c);
  const ns = roads.filter((r) => r.dir === 'NS');
  const ewC = ew.map((r) => r.c);
  const lower = (v: number) => {
    let lo = 0;
    let hi = ewC.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ewC[m] < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const rank: Record<RoadKind, number> = { motorway: 4, arterial: 3, collector: 2, local: 1, service: 0 };
  for (const n of ns) {
    for (let k = lower(n.a); k < ewC.length && ewC[k] <= n.b; k++) {
      const e = ew[k];
      if (n.c < e.a || n.c > e.b) continue;
      junctions.push({ x: n.c, z: e.c, wEW: e.width, wNS: n.width, kind: rank[e.kind] >= rank[n.kind] ? e.kind : n.kind });
    }
  }

  return { size, half, centre, centres, coast, rivers, airport, port, roads, junctions, rails, stations, districts, blocks, isWater, shoreX, riverX, riverWidth, waterLevel };
}
