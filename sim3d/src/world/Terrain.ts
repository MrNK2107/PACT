import { Noise2D } from './noise';
import type { HeightField, WorldBounds } from './types';

/**
 * Terrain elevation. A HeightField is a regular grid of ground heights (metres above the datum that
 * the flat world used, so a flat map is simply an all-zero field). Heights are sampled bilinearly.
 *
 * Design rules (docs/DECISIONS.md, Decision 9):
 *  - the field is smooth: no terracing, so roads and ground form one continuous surface;
 *  - buildings stand on the highest ground under their footprint and carry a foundation down to the
 *    lowest, so nothing floats or sinks;
 *  - water stays where the shoreline logic says it is: the field is forced to the sea bed there and to 0
 *    along the banks, so every generator that keys off the shoreline keeps working;
 *  - generation uses its own noise stream (seed + 6) and never the shared RNG, so enabling terrain does
 *    not change any other random draw.
 */

export type TerrainConfig = { kind: 'none' } | { kind: 'hills'; amplitude_m: number; wavelength_m: number };

export const TERRAIN_PRESETS: Record<string, TerrainConfig> = {
  none: { kind: 'none' },
  gentle: { kind: 'hills', amplitude_m: 14, wavelength_m: 2600 },
  hilly: { kind: 'hills', amplitude_m: 30, wavelength_m: 2000 },
  mountain: { kind: 'hills', amplitude_m: 60, wavelength_m: 2400 },
};

/** The sea bed under the sea plane (waterY = -0.9). */
const SEABED = -2.9;

export function flatTerrain(bounds: WorldBounds): HeightField {
  return { cell: Math.max(1, bounds.maxX - bounds.minX), nx: 2, nz: 2, originX: bounds.minX, originZ: bounds.minZ, h: new Float32Array(4), minY: 0, maxY: 0, flat: true };
}

/** Bilinear ground height at (x, z); clamped to the grid. Exactly 0 for a flat field. */
export function heightAt(f: HeightField, x: number, z: number): number {
  if (f.flat) return 0;
  const fx = Math.min(f.nx - 1.001, Math.max(0, (x - f.originX) / f.cell));
  const fz = Math.min(f.nz - 1.001, Math.max(0, (z - f.originZ) / f.cell));
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  const tx = fx - i;
  const tz = fz - j;
  const k00 = j * f.nx + i;
  const a = f.h[k00] + (f.h[k00 + 1] - f.h[k00]) * tx;
  const b = f.h[k00 + f.nx] + (f.h[k00 + f.nx + 1] - f.h[k00 + f.nx]) * tx;
  return a + (b - a) * tz;
}

/** Highest and lowest ground under a footprint (centre, corners and edge midpoints). */
export function footprintGround(f: HeightField, cx: number, cz: number, w: number, d: number): { max: number; min: number } {
  if (f.flat) return { max: 0, min: 0 };
  let max = -Infinity;
  let min = Infinity;
  for (const dx of [-0.5, 0, 0.5]) {
    for (const dz of [-0.5, 0, 0.5]) {
      const h = heightAt(f, cx + dx * w, cz + dz * d);
      if (h > max) max = h;
      if (h < min) min = h;
    }
  }
  return { max, min };
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** What the generator needs to know about the layout (so Terrain does not depend on CityLayout). */
export interface TerrainLayout {
  coast: boolean;
  river: boolean;
  shoreX: (z: number) => number;
  riverX: (z: number) => number | null;
  riverWidth: (z: number) => number;
  airport: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

export function generateTerrain(seed: number, bounds: WorldBounds, cfg: TerrainConfig, layout: TerrainLayout): HeightField {
  if (cfg.kind === 'none') return flatTerrain(bounds);
  const size = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const cell = size <= 8000 ? 10 : 20;
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cell) + 1;
  const nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell) + 1;
  const noise = new Noise2D(seed + 6);
  const h = new Float32Array(nx * nz);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let j = 0; j < nz; j++) {
    const z = bounds.minZ + j * cell;
    for (let i = 0; i < nx; i++) {
      const x = bounds.minX + i * cell;
      const n = noise.fbm(x, z, cfg.wavelength_m, 4);
      let y = cfg.amplitude_m * smoothstep(0.25, 0.92, n);
      // distance to the nearest water edge (negative = in water)
      let d = Infinity;
      if (layout.coast) d = Math.min(d, layout.shoreX(z) - x);
      if (layout.river) {
        const rx = layout.riverX(z);
        if (rx !== null) d = Math.min(d, Math.abs(x - rx) - layout.riverWidth(z) / 2);
      }
      if (d < Infinity) {
        if (d < 0) y = SEABED - Math.min(12, -d * 0.03);
        else y *= smoothstep(40, 300, d);
      }
      if (y > 0) y *= smoothstep(0, 300, Math.min(x - bounds.minX, bounds.maxX - x, z - bounds.minZ, bounds.maxZ - z));
      const a = layout.airport;
      if (a && x > a.minX - 40 && x < a.maxX + 40 && z > a.minZ - 40 && z < a.maxZ + 40) y = 0;
      h[j * nx + i] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { cell, nx, nz, originX: bounds.minX, originZ: bounds.minZ, h, minY, maxY, flat: maxY === 0 && minY === 0 };
}
