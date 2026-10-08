import type { Rng } from './rng';
import type { DistrictKind } from './types';

export type PaletteFamily = 'old' | 'modern' | 'industrial' | 'suburban' | 'coastal';

export interface Palette {
  family: PaletteFamily;
  /** Facade colours this district draws from (3 picked from the family). */
  facade: string[];
  roof: string[];
  glass: string[];
  lawn: string;
  paving: string;
  /** Share of brick / stone / glass facades (rest plaster / concrete / panel). */
  brick: number;
  glassShare: number;
}

const FAMILY: Record<PaletteFamily, { facade: string[]; roof: string[]; glass: string[]; lawn: string[]; paving: string[]; brick: number; glassShare: number }> = {
  old: {
    facade: ['#d9cfbd', '#cdb896', '#b98f6d', '#a8654d', '#e3d6c2', '#c7a98a', '#9d6b57', '#d8b48f', '#b7a27f', '#e8dccb', '#8f5f4e', '#c9b7a1'],
    roof: ['#7a4a3b', '#6b4f45', '#5f5a55', '#8a5a44', '#4f5256', '#7d5d4c'],
    glass: ['#566a78', '#5b7080', '#4f6474'],
    lawn: ['#6f8a55', '#728c5a', '#6a8450'],
    paving: ['#b2aea5', '#aaa69d', '#b8b3a8'],
    brick: 0.55,
    glassShare: 0.05,
  },
  modern: {
    facade: ['#d9d2c3', '#c4c2bb', '#b9b8b3', '#e0dcd2', '#aaa9a4', '#cfd3d6', '#9aa3ab', '#dad6cf', '#8e949a', '#c9c7c0', '#e6e3dd', '#a0a09b'],
    roof: ['#5f5a55', '#4f5256', '#6a6a66'],
    glass: ['#3e5668', '#4d6272', '#6f8798', '#7f97a8', '#35505f', '#8aa0b0'],
    lawn: ['#6c8650', '#6f8a55'],
    paving: ['#aeada7', '#b5b4ae', '#a6a5a0'],
    brick: 0.12,
    glassShare: 0.45,
  },
  industrial: {
    facade: ['#c9ccce', '#b7bcc0', '#d4d6d3', '#a9b2b8', '#9ea4a8', '#cfd0cc', '#8f9296', '#b3b6b4', '#dcdcd8', '#a2a7ab'],
    roof: ['#7b7f84', '#6a6e72', '#8c9094'],
    glass: ['#444c52', '#3a4247'],
    lawn: ['#7d8a62'],
    paving: ['#a3a39e', '#9a9a95', '#a9a9a2'],
    brick: 0.08,
    glassShare: 0.02,
  },
  suburban: {
    facade: ['#e0d9ca', '#d6cdbd', '#c9c0ae', '#efe6d6', '#d2c2a8', '#c4a98c', '#e9e2d4', '#b5a48a', '#dcd0bc', '#f1ebe0', '#bfae96', '#cfc7b6'],
    roof: ['#7a4a3b', '#5f5a55', '#6b4f45', '#4f5256', '#8a6a50', '#55606a', '#704a3f'],
    glass: ['#5b7080', '#566a78'],
    lawn: ['#7a9558', '#7d9560', '#729050', '#80985c'],
    paving: ['#b7b3aa', '#b0ada6'],
    brick: 0.3,
    glassShare: 0.03,
  },
  coastal: {
    facade: ['#f2efe6', '#e8e4da', '#dfe7ea', '#f6f1e3', '#cfdbe0', '#e9dfcf', '#f0e8d8', '#d8e2e6', '#efeae0', '#c9d6dc'],
    roof: ['#8f6a52', '#6d7f8a', '#5f5a55', '#7b5d4c'],
    glass: ['#4f6b7d', '#5b7f93', '#6f93a7'],
    lawn: ['#7a9a66', '#789562'],
    paving: ['#c3bfb4', '#bdb9ae'],
    brick: 0.12,
    glassShare: 0.18,
  },
};

export function familyFor(kind: DistrictKind, rng: Rng, nearCoast: boolean): PaletteFamily {
  if (nearCoast && rng.chance(0.7)) return 'coastal';
  switch (kind) {
    case 'cbd':
    case 'commercial':
      return 'modern';
    case 'mixed':
    case 'apartments':
      return rng.chance(0.45) ? 'old' : 'modern';
    case 'townhouses':
      return rng.chance(0.7) ? 'old' : 'suburban';
    case 'houses':
    case 'suburb':
      return rng.chance(0.25) ? 'old' : 'suburban';
    case 'industrial':
    case 'logistics':
    case 'port':
      return 'industrial';
    case 'waterfront':
      return 'coastal';
    default:
      return 'suburban';
  }
}

/** Each district draws its own subset so neighbourhoods are coherent but differ from each other. */
export function makePalette(family: PaletteFamily, rng: Rng): Palette {
  const f = FAMILY[family];
  const pickN = (arr: string[], n: number) => {
    const pool = arr.slice();
    const out: string[] = [];
    for (let i = 0; i < n && pool.length; i++) out.push(pool.splice(rng.int(0, pool.length - 1), 1)[0]);
    return out;
  };
  return {
    family,
    facade: pickN(f.facade, 4),
    roof: pickN(f.roof, 2),
    glass: pickN(f.glass, 2),
    lawn: rng.pick(f.lawn),
    paving: rng.pick(f.paving),
    brick: f.brick,
    glassShare: f.glassShare,
  };
}

/** Small deterministic HSL jitter so identical palette entries never read as copies. */
export function jitter(hex: string, rng: Rng, amount = 0.035): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255;
  let g = (n >> 8) & 255;
  let b = n & 255;
  const k = 1 + rng.range(-amount, amount);
  const warm = rng.range(-amount, amount) * 40;
  r = Math.max(0, Math.min(255, Math.round(r * k + warm)));
  g = Math.max(0, Math.min(255, Math.round(g * k)));
  b = Math.max(0, Math.min(255, Math.round(b * k - warm)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
