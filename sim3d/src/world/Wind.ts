import { Noise2D } from './noise';
import type { WindField, WorldBounds } from './types';

/**
 * Wind as a parametrised disturbance field (assumption T11): a mean vector plus gusty spatial
 * variation, sampled on a regular grid. It only modifies energy cost; kinematics ignore it.
 * Fields can be retargeted at runtime (weather fronts) and boosted locally (storm cells); both are
 * pure functions of the field and the parameters, so a run stays deterministic.
 */

export interface WindParams {
  mean_mps: number;
  dir_deg?: number;
  gust_mps?: number;
}

export interface WindBoost {
  x: number;
  z: number;
  /** Radius of the affected area (m); the boost fades smoothly to zero at the edge. */
  r: number;
  /** Extra wind speed at the centre (m/s), blowing along the local wind direction. */
  mps: number;
}

const CELL = 100;
const WATER_BOOST = 1.15;

function build(seed: number, bounds: WorldBounds, cfg: WindParams, water: Uint8Array | null, nx: number, nz: number): WindField {
  const mean = Math.max(0, cfg.mean_mps);
  const dirDeg = cfg.dir_deg ?? 240;
  const gust = cfg.gust_mps ?? Math.min(mean * 0.6, 4);
  const rad = (dirDeg * Math.PI) / 180;
  // meteorological convention: direction the wind blows *from*; +X east, +Z south (north = -Z)
  const ux = -Math.sin(rad);
  const uz = Math.cos(rad);
  const nA = new Noise2D(seed + 7001);
  const nB = new Noise2D(seed + 7002);
  const vx = new Float32Array(nx * nz);
  const vz = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = bounds.minX + i * CELL;
      const z = bounds.minZ + j * CELL;
      const k = water && water[j * nx + i] ? WATER_BOOST : 1;
      const a = (nA.fbm(x, z, 900, 3) - 0.5) * 2 * gust;
      const b = (nB.fbm(x, z, 900, 3) - 0.5) * 2 * gust;
      vx[j * nx + i] = (mean * ux + a) * k;
      vz[j * nx + i] = (mean * uz + b) * k;
    }
  }
  return { cell: CELL, nx, nz, originX: bounds.minX, originZ: bounds.minZ, mean, dirDeg, gust, vx, vz, seed, bounds, water: water ?? undefined };
}

export function generateWind(seed: number, bounds: WorldBounds, cfg: WindParams, isOpenWater?: (x: number, z: number) => boolean): WindField {
  const nx = Math.ceil((bounds.maxX - bounds.minX) / CELL) + 1;
  const nz = Math.ceil((bounds.maxZ - bounds.minZ) / CELL) + 1;
  let water: Uint8Array | null = null;
  if (isOpenWater) {
    water = new Uint8Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) water[j * nx + i] = isOpenWater(bounds.minX + i * CELL, bounds.minZ + j * CELL) ? 1 : 0;
  }
  return build(seed, bounds, cfg, water, nx, nz);
}

/** A field with the same grid, noise and water mask as `base` but new mean / direction / gusts. */
export function retargetWind(base: WindField, cfg: WindParams): WindField {
  if (base.seed === undefined || !base.bounds) throw new Error('wind field cannot be retargeted (no generation data)');
  return build(base.seed, base.bounds, cfg, base.water ?? null, base.nx, base.nz);
}

/** Linear blend of two parameter sets (t = 0 gives `a`, t = 1 gives `b`); directions take the short way round. */
export function blendWindParams(a: Required<WindParams>, b: Required<WindParams>, t: number): Required<WindParams> {
  let dd = (((b.dir_deg - a.dir_deg) % 360) + 540) % 360 - 180;
  if (!isFinite(dd)) dd = 0;
  return { mean_mps: a.mean_mps + (b.mean_mps - a.mean_mps) * t, dir_deg: (((a.dir_deg + dd * t) % 360) + 360) % 360, gust_mps: a.gust_mps + (b.gust_mps - a.gust_mps) * t };
}

/** A copy of the field with local boosts (storm cells) added along the local wind direction. */
export function boostWind(f: WindField, boosts: readonly WindBoost[]): WindField {
  if (!boosts.length) return f;
  const vx = Float32Array.from(f.vx);
  const vz = Float32Array.from(f.vz);
  for (const b of boosts) {
    const i0 = Math.max(0, Math.floor((b.x - b.r - f.originX) / f.cell));
    const i1 = Math.min(f.nx - 1, Math.ceil((b.x + b.r - f.originX) / f.cell));
    const j0 = Math.max(0, Math.floor((b.z - b.r - f.originZ) / f.cell));
    const j1 = Math.min(f.nz - 1, Math.ceil((b.z + b.r - f.originZ) / f.cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const d = Math.hypot(f.originX + i * f.cell - b.x, f.originZ + j * f.cell - b.z);
        if (d >= b.r) continue;
        const t = 1 - d / b.r;
        const fall = t * t * (3 - 2 * t);
        const k = j * f.nx + i;
        const sp = Math.hypot(vx[k], vz[k]);
        // along the existing wind; with a dead calm the storm blows along the field's mean direction
        const rad = (f.dirDeg * Math.PI) / 180;
        const ux = sp > 1e-6 ? vx[k] / sp : -Math.sin(rad);
        const uz = sp > 1e-6 ? vz[k] / sp : Math.cos(rad);
        vx[k] += ux * b.mps * fall;
        vz[k] += uz * b.mps * fall;
      }
    }
  }
  return { ...f, vx, vz };
}

/** Bilinear sample of the wind vector at (x,z). */
export function windAt(f: WindField, x: number, z: number): { vx: number; vz: number } {
  const fx = Math.min(f.nx - 1.001, Math.max(0, (x - f.originX) / f.cell));
  const fz = Math.min(f.nz - 1.001, Math.max(0, (z - f.originZ) / f.cell));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k00 = j * f.nx + i;
  const k10 = k00 + 1;
  const k01 = k00 + f.nx;
  const k11 = k01 + 1;
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return {
    vx: lerp(lerp(f.vx[k00], f.vx[k10], tx), lerp(f.vx[k01], f.vx[k11], tx), tz),
    vz: lerp(lerp(f.vz[k00], f.vz[k10], tx), lerp(f.vz[k01], f.vz[k11], tx), tz),
  };
}
