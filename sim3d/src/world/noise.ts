/**
 * Deterministic 2-D value noise with fractal octaves. Pure function of (seed, x, y) so the city
 * layout never depends on evaluation order.
 */
function hash2(seed: number, ix: number, iy: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export class Noise2D {
  constructor(private seed: number) {}

  /** Single octave, 0…1. `x`, `y` in noise units (one cell = 1). */
  value(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = smooth(x - ix);
    const fy = smooth(y - iy);
    const a = hash2(this.seed, ix, iy);
    const b = hash2(this.seed, ix + 1, iy);
    const c = hash2(this.seed, ix, iy + 1);
    const d = hash2(this.seed, ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** Fractal noise, roughly 0…1, at world coordinates with the base wavelength `scale` (metres). */
  fbm(x: number, y: number, scale: number, octaves = 4, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1 / scale;
    for (let o = 0; o < octaves; o++) {
      sum += this.value(x * f + o * 17.3, y * f + o * 11.7) * amp;
      norm += amp;
      amp *= gain;
      f *= 2;
    }
    return sum / norm;
  }
}
