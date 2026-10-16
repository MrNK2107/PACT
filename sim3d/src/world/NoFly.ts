import type { AABB2, NoFlyShape, NoFlySpec, NoFlyZone } from './types';

/**
 * No-fly zone geometry (circle / box / polygon). Pure functions shared by the generator, the
 * ObstacleManager, the planner, the renderer and the tests, so every consumer agrees on what
 * "inside" means. Polygons use even-odd point-in-polygon; distances are signed (negative inside).
 */

export function polygonBounds(points: { x: number; z: number }[]): AABB2 {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function polygonShape(points: { x: number; z: number }[]): NoFlyShape {
  return { type: 'polygon', points: points.map((p) => ({ x: p.x, z: p.z })), bbox: polygonBounds(points) };
}

export function shapeBounds(s: NoFlyShape): AABB2 {
  if (s.type === 'circle') return { minX: s.x - s.r, maxX: s.x + s.r, minZ: s.z - s.r, maxZ: s.z + s.r };
  if (s.type === 'box') return { minX: s.minX, maxX: s.maxX, minZ: s.minZ, maxZ: s.maxZ };
  return s.bbox;
}

export function shapeCentre(s: NoFlyShape): { x: number; z: number } {
  const b = shapeBounds(s);
  return { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
}

function pointInPolygon(pts: { x: number; z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Point inside the shape, optionally inflated by `margin` metres. */
export function pointInShape(s: NoFlyShape, x: number, z: number, margin = 0): boolean {
  if (s.type === 'circle') return (x - s.x) ** 2 + (z - s.z) ** 2 < (s.r + margin) ** 2;
  if (s.type === 'box') return x > s.minX - margin && x < s.maxX + margin && z > s.minZ - margin && z < s.maxZ + margin;
  if (x < s.bbox.minX - margin || x > s.bbox.maxX + margin || z < s.bbox.minZ - margin || z > s.bbox.maxZ + margin) return false;
  if (margin <= 0) return pointInPolygon(s.points, x, z);
  return shapeDistance(s, x, z).d < margin;
}

/** Signed horizontal distance to the boundary (negative = inside) plus the outward unit normal. */
export function shapeDistance(s: NoFlyShape, x: number, z: number): { d: number; nx: number; nz: number } {
  if (s.type === 'circle') {
    const dx = x - s.x;
    const dz = z - s.z;
    const d = Math.hypot(dx, dz) || 1e-6;
    return { d: d - s.r, nx: dx / d, nz: dz / d };
  }
  if (s.type === 'box') {
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const hx = (s.maxX - s.minX) / 2;
    const hz = (s.maxZ - s.minZ) / 2;
    const qx = Math.abs(x - cx) - hx;
    const qz = Math.abs(z - cz) - hz;
    const outside = Math.hypot(Math.max(qx, 0), Math.max(qz, 0));
    const d = outside > 0 ? outside : Math.max(qx, qz);
    let nx = 0;
    let nz = 0;
    if (outside > 0) {
      nx = Math.max(qx, 0) * Math.sign(x - cx);
      nz = Math.max(qz, 0) * Math.sign(z - cz);
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
    } else if (qx > qz) nx = Math.sign(x - cx) || 1;
    else nz = Math.sign(z - cz) || 1;
    return { d, nx, nz };
  }
  // polygon: nearest point on any edge
  const pts = s.points;
  let best = Infinity;
  let bx = 0;
  let bz = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j];
    const b = pts[i];
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const l2 = ex * ex + ez * ez || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / l2));
    const px = a.x + ex * t;
    const pz = a.z + ez * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) {
      best = d2;
      bx = px;
      bz = pz;
    }
  }
  const dist = Math.sqrt(best);
  const inside = pointInPolygon(pts, x, z);
  let nx = x - bx;
  let nz = z - bz;
  const l = Math.hypot(nx, nz);
  if (l < 1e-6) {
    const c = shapeCentre(s);
    nx = x - c.x;
    nz = z - c.z;
    const l2 = Math.hypot(nx, nz) || 1;
    nx /= l2;
    nz /= l2;
  } else {
    nx /= l;
    nz /= l;
    if (inside) {
      nx = -nx;
      nz = -nz;
    }
  }
  return { d: inside ? -dist : dist, nx, nz };
}

/** A ceiling: a zone that only closes the air above `minY` (altitude cap, storm ceiling). */
export function isCap(z: NoFlyZone): boolean {
  return (z.minY ?? 0) > 0;
}

/** True if (x,z) is inside any zone (inflated by `margin`). `onlyActive` ignores opened zones. */
export function inNoFly(zones: readonly NoFlyZone[], x: number, z: number, margin = 0, onlyActive = true): boolean {
  for (const n of zones) {
    if (onlyActive && !n.active) continue;
    if (pointInShape(n.shape, x, z, margin)) return true;
  }
  return false;
}

/** Simple-polygon check (no self-intersections, >= 3 points). */
export function polygonIsSimple(pts: { x: number; z: number }[]): boolean {
  if (pts.length < 3) return false;
  const n = pts.length;
  const cross = (ax: number, az: number, bx: number, bz: number) => ax * bz - az * bx;
  const inter = (p1: { x: number; z: number }, p2: { x: number; z: number }, p3: { x: number; z: number }, p4: { x: number; z: number }) => {
    const d1 = cross(p4.x - p3.x, p4.z - p3.z, p1.x - p3.x, p1.z - p3.z);
    const d2 = cross(p4.x - p3.x, p4.z - p3.z, p2.x - p3.x, p2.z - p3.z);
    const d3 = cross(p2.x - p1.x, p2.z - p1.z, p3.x - p1.x, p3.z - p1.z);
    const d4 = cross(p2.x - p1.x, p2.z - p1.z, p4.x - p1.x, p4.z - p1.z);
    return d1 * d2 < 0 && d3 * d4 < 0;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (inter(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Builds a NoFlyZone from a scenario spec (coordinates already in world x/z). */
export function zoneFromSpec(spec: Exclude<NoFlySpec, 'auto'>, index: number): NoFlyZone {
  let shape: NoFlyShape;
  if (spec.circle) shape = { type: 'circle', x: spec.circle.x, z: spec.circle.z, r: spec.circle.r };
  else if (spec.box) shape = { type: 'box', ...spec.box };
  else if (spec.polygon) shape = polygonShape(spec.polygon);
  else throw new Error(`no_fly[${index}] needs circle, box or polygon`);
  return {
    id: spec.id ?? `NFZ-S${String(index + 1).padStart(2, '0')}`,
    name: spec.name ?? `Scenario zone ${index + 1}`,
    reason: spec.reason ?? 'Scenario restriction',
    shape,
    maxY: spec.maxY ?? 120,
    closable: spec.closable ?? false,
    active: spec.active ?? true,
    source: 'scenario',
  };
}
