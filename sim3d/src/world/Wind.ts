import { Noise2D } from './noise';
import type { WindField, WorldBounds } from './types';

/**
 * Wind as a parametrised disturbance field (assumption T11): a mean vector plus gusty spatial
 * variation, sampled on a regular grid. It only modifies energy cost; kinematics ignore it.
 */
export function generateWind(seed: number, bounds: WorldBounds, cfg: { mean_mps: number; dir_deg?: number; gust_mps?: number }, isOpenWater?: (x: number, z: number) => boolean): WindField {
  const cell = 100;
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
  const nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
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
      const x = bounds.minX + i * cell;
      const z = bounds.minZ + j * cell;
      const k = isOpenWater && isOpenWater(x, z) ? 1.15 : 1;
      const a = (nA.fbm(x, z, 900, 3) - 0.5) * 2 * gust;
      const b = (nB.fbm(x, z, 900, 3) - 0.5) * 2 * gust;
      vx[j * nx + i] = (mean * ux + a) * k;
      vz[j * nx + i] = (mean * uz + b) * k;
    }
  }
  return { cell, nx, nz, originX: bounds.minX, originZ: bounds.minZ, mean, dirDeg, gust, vx, vz };
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
