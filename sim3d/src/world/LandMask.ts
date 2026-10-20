import { Noise2D } from './noise';
import { Rng } from './rng';

/**
 * Land masks for geographies where the water is not a straight coastline: archipelagos and lakes.
 * A mask returns the signed distance-like margin to the shore in metres: positive on land, zero or
 * negative in water. The layout uses it to decide where blocks and roads can go, the terrain to carve
 * the sea bed, and the depot siting to give every large island its own depot. Pure functions of
 * (seed, size): no RNG state is consumed.
 */

export type LandMask = (x: number, z: number) => number;

export function makeLandMask(kind: 'islands' | 'lake', seed: number, size: number): LandMask {
  const half = size / 2;
  if (kind === 'lake') {
    const n = new Noise2D(seed + 41);
    const cx = 0.08 * size;
    const cz = -0.06 * size;
    return (x, z) => {
      const ang = Math.atan2(z - cz, x - cx);
      // an irregular shoreline: the lake radius wobbles around the circle
      const wob = n.fbm(Math.cos(ang) * 900 + 5000, Math.sin(ang) * 900 + 5000, 600, 3) - 0.5;
      const r = 0.21 * size * (1 + 0.55 * wob);
      return Math.hypot(x - cx, z - cz) - r;
    };
  }
  // an archipelago: a handful of islands, each a disc whose radius wobbles around the circle, kept apart by open water.
  // A private RNG places them, so the shared generator stream is untouched.
  const rng = new Rng(seed + 33);
  const count = Math.max(3, Math.round(size / 1500));
  const isl: { x: number; z: number; r: number; phase: number }[] = [];
  for (let attempt = 0; isl.length < count && attempt < 600; attempt++) {
    const r = rng.range(0.1, 0.2) * size;
    const x = rng.range(-half + r * 1.5, half - r * 1.5);
    const z = rng.range(-half + r * 1.5, half - r * 1.5);
    if (isl.every((o) => Math.hypot(o.x - x, o.z - z) > (o.r + r) * 1.3 + 300)) isl.push({ x, z, r, phase: rng.range(0, 1000) });
  }
  const wob = new Noise2D(seed + 34);
  return (x, z) => {
    let best = -Infinity;
    for (const o of isl) {
      const ang = Math.atan2(z - o.z, x - o.x);
      const w = wob.fbm(Math.cos(ang) * 700 + o.phase, Math.sin(ang) * 700 + o.phase, 450, 3) - 0.5;
      const m = o.r * (1 + 0.5 * w) - Math.hypot(x - o.x, z - o.z);
      if (m > best) best = m;
    }
    return best;
  };
}

/** Labels connected land cells on a coarse grid. Returns a function from (x, z) to a landmass id (-1 in water). */
export function labelLandmasses(mask: LandMask, size: number, step = 100): { of: (x: number, z: number) => number; areaKm2: number[] } {
  const half = size / 2;
  const n = Math.ceil(size / step) + 1;
  const label = new Int32Array(n * n).fill(-1);
  const land = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) land[j * n + i] = mask(-half + i * step, -half + j * step) > 0 ? 1 : 0;
  const areas: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n * n; s++) {
    if (!land[s] || label[s] >= 0) continue;
    const id = areas.length;
    let count = 0;
    stack.push(s);
    label[s] = id;
    while (stack.length) {
      const c = stack.pop()!;
      count++;
      const ci = c % n;
      const cj = (c / n) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di;
        const nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        const k = nj * n + ni;
        if (land[k] && label[k] < 0) {
          label[k] = id;
          stack.push(k);
        }
      }
    }
    areas.push((count * step * step) / 1e6);
  }
  return {
    of: (x, z) => {
      const i = Math.round((x + half) / step);
      const j = Math.round((z + half) / step);
      if (i < 0 || j < 0 || i >= n || j >= n) return -1;
      return label[j * n + i];
    },
    areaKm2: areas,
  };
}
