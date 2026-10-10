import * as THREE from 'three';
import { Rng } from '../world/rng';

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return [c, c.getContext('2d')!];
}

function finish(c: HTMLCanvasElement, repeat = true, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Tileable speckled surface (concrete, grass, asphalt). */
export function noiseTexture(base: string, variance: number, opts: { size?: number; seed?: number; blotch?: number; cracks?: number } = {}): THREE.CanvasTexture {
  const size = opts.size ?? 256;
  const rng = new Rng(opts.seed ?? 1);
  const [c, ctx] = canvas(size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const blotches = opts.blotch ?? 40;
  for (let i = 0; i < blotches; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(8, 40);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const a = rng.range(-0.06, 0.06);
    const col = a > 0 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${-a})`;
    g.addColorStop(0, col);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    for (const ox of [-size, 0, size]) for (const oy of [-size, 0, size]) ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
  }
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rng.next() - 0.5) * variance;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i < (opts.cracks ?? 0); i++) {
    ctx.beginPath();
    let x = rng.range(0, size);
    let y = rng.range(0, size);
    ctx.moveTo(x, y);
    for (let k = 0; k < 6; k++) {
      x += rng.range(-14, 14);
      y += rng.range(-14, 14);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return finish(c);
}

export function hatchTexture(color: string): THREE.CanvasTexture {
  const [c, ctx] = canvas(128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = color;
  ctx.lineWidth = 7;
  for (let i = -128; i < 256; i += 32) {
    ctx.beginPath();
    ctx.moveTo(i, 128);
    ctx.lineTo(i + 128, 0);
    ctx.stroke();
  }
  return finish(c);
}

export function padTexture(letter: string, ring: string, bg: string, text = '#ffffff'): THREE.CanvasTexture {
  const [c, ctx] = canvas(256);
  ctx.clearRect(0, 0, 256, 256);
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(128, 128, 124, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.arc(128, 128, 108, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(128, 128, 90, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = text;
  ctx.font = '700 120px system-ui, "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, 128, 136);
  return finish(c, false);
}

export function waterTexture(): THREE.CanvasTexture {
  const [c, ctx] = canvas(256);
  const rng = new Rng(7);
  ctx.fillStyle = '#4a7a8f';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 260; i++) {
    const x = rng.range(0, 256);
    const y = rng.range(0, 256);
    const w = rng.range(10, 40);
    ctx.strokeStyle = rng.chance(0.5) ? 'rgba(255,255,255,0.10)' : 'rgba(10,40,60,0.12)';
    ctx.lineWidth = rng.range(1, 3);
    for (const ox of [-256, 0, 256]) {
      ctx.beginPath();
      ctx.moveTo(x + ox, y);
      ctx.quadraticCurveTo(x + ox + w / 2, y + rng.range(-3, 3), x + ox + w, y);
      ctx.stroke();
    }
  }
  return finish(c);
}
