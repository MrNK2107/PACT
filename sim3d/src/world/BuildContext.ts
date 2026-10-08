import { Rng } from './rng';
import type { BalconyData, BuildingData, BuildingKind, RoofEquipment, RoofKind, TreeData, ZoneType } from './types';

export interface BuildingSpec {
  name: string;
  kind: BuildingKind;
  zone: ZoneType;
  blockId: string;
  cx: number;
  cz: number;
  w: number;
  d: number;
  h: number;
  baseY?: number;
  roof?: RoofKind;
  color: string;
  material: BuildingData['material'];
  balconies?: boolean;
  /** Number of rooftop equipment items to scatter. */
  equipment?: number;
  /** Antenna mast on the roof (adds to collision height). */
  mast?: boolean;
  /** Keep roof clear (landing pad): collision top == roof surface. */
  solidTop?: boolean;
  /** Circle on the roof where no equipment may be placed. */
  keepout?: { x: number; z: number; r: number };
  /** Rooftop solar array. */
  solar?: boolean;
  rot?: number;
}

/** Candidate drop-point site on a flat roof (registered by block fillers). */
export interface RoofSite {
  buildingId: string;
  blockId: string;
  districtId: string;
  zone: ZoneType;
  x: number;
  y: number;
  z: number;
  name: string;
}

/** Candidate drop-point site on the ground (registered by block fillers). */
export interface GroundSite {
  blockId: string;
  districtId: string;
  zone: ZoneType;
  x: number;
  z: number;
  name: string;
  buildingId?: string;
}

export const FLOOR_H = 3.2;

export function gableRise(w: number, d: number): number {
  return Math.min(w, d) * 0.3;
}

/** Spatial hash of circular keep-out areas so `clear()` stays O(1) on a 100k+ entity map. */
class KeepoutGrid {
  private cells = new Map<number, { x: number; z: number; r: number }[]>();
  private readonly cs = 40;
  count = 0;
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  add(k: { x: number; z: number; r: number }): void {
    const { cs } = this;
    for (let i = Math.floor((k.x - k.r) / cs); i <= Math.floor((k.x + k.r) / cs); i++) {
      for (let j = Math.floor((k.z - k.r) / cs); j <= Math.floor((k.z + k.r) / cs); j++) {
        const kk = this.key(i, j);
        let l = this.cells.get(kk);
        if (!l) this.cells.set(kk, (l = []));
        l.push(k);
      }
    }
    this.count++;
  }
  clear(x: number, z: number, r: number): boolean {
    const { cs } = this;
    for (let i = Math.floor((x - r) / cs); i <= Math.floor((x + r) / cs); i++) {
      for (let j = Math.floor((z - r) / cs); j <= Math.floor((z + r) / cs); j++) {
        const l = this.cells.get(this.key(i, j));
        if (!l) continue;
        for (const k of l) if ((k.x - x) ** 2 + (k.z - z) ** 2 < (k.r + r) ** 2) return false;
      }
    }
    return true;
  }
}

/** Mutable accumulator shared by the city generator and the logistics generator. */
export class BuildContext {
  readonly rng: Rng;
  readonly buildings: BuildingData[] = [];
  readonly equipment: RoofEquipment[] = [];
  readonly balconies: BalconyData[] = [];
  readonly trees: TreeData[] = [];
  readonly keepouts = new KeepoutGrid();
  readonly roofSites: RoofSite[] = [];
  readonly groundSites: GroundSite[] = [];
  private bn = 0;
  private tn = 0;

  constructor(seed: number) {
    this.rng = new Rng(seed);
  }

  keepout(x: number, z: number, r: number): void {
    this.keepouts.add({ x, z, r });
  }

  clear(x: number, z: number, r: number): boolean {
    return this.keepouts.clear(x, z, r);
  }

  addTree(x: number, z: number, minH = 6, maxH = 12, conifer = 0.15, species?: TreeData['species']): TreeData | null {
    const rng = this.rng;
    if (!this.clear(x, z, 1.2)) return null;
    const height = rng.range(minH, maxH);
    const sp: TreeData['species'] = species ?? (rng.chance(conifer) ? 'conifer' : 'broadleaf');
    const t: TreeData = {
      id: `T-${String(++this.tn).padStart(6, '0')}`,
      x,
      z,
      height,
      radius: height * (sp === 'palm' ? 0.28 : sp === 'cypress' ? 0.12 : rng.range(0.22, 0.34)),
      species: sp,
      shade: rng.range(0.75, 1.15),
    };
    this.trees.push(t);
    return t;
  }

  addBuilding(s: BuildingSpec): BuildingData {
    const rng = this.rng;
    const baseY = s.baseY ?? 0;
    const roof = s.roof ?? 'flat';
    let extra = 0;
    if (roof === 'gable' || roof === 'hip') extra = gableRise(s.w, s.d);
    else if (roof === 'sawtooth') extra = 2.5;
    else if (roof === 'barrel') extra = Math.min(s.w, s.d) * 0.22;
    else if (!s.solidTop) extra = s.mast ? 8 : s.equipment ? 3.5 : 0.8;
    const id = `B-${String(++this.bn).padStart(6, '0')}`;
    const b: BuildingData = {
      id,
      name: s.name,
      kind: s.kind,
      zone: s.zone,
      blockId: s.blockId,
      cx: s.cx,
      cz: s.cz,
      w: s.w,
      d: s.d,
      h: s.h,
      baseY,
      roof,
      color: s.color,
      material: s.material,
      hasBalconies: !!s.balconies,
      bounds: {
        minX: s.cx - s.w / 2,
        maxX: s.cx + s.w / 2,
        minY: baseY,
        maxY: baseY + s.h + extra,
        minZ: s.cz - s.d / 2,
        maxZ: s.cz + s.d / 2,
      },
      rooftopPadIds: [],
      rot: s.rot,
    };
    this.buildings.push(b);

    const roofY = baseY + s.h;
    if (roof === 'flat') {
      const n = s.equipment ?? 0;
      for (let i = 0; i < n; i++) {
        for (let attempt = 0; attempt < 6; attempt++) {
          const sx = rng.range(1.6, 3.6);
          const sz = rng.range(1.6, 3.6);
          if (s.w < sx + 3 || s.d < sz + 3) break;
          const x = s.cx + rng.range(-s.w / 2 + sx / 2 + 1, s.w / 2 - sx / 2 - 1);
          const z = s.cz + rng.range(-s.d / 2 + sz / 2 + 1, s.d / 2 - sz / 2 - 1);
          if (s.keepout && (x - s.keepout.x) ** 2 + (z - s.keepout.z) ** 2 < (s.keepout.r + 2.2) ** 2) continue;
          const roll = rng.next();
          const type: RoofEquipment['type'] = roll < 0.18 ? 'tank' : roll < 0.3 ? 'stairhead' : roll < 0.38 ? 'skylight' : 'hvac';
          const tank = type === 'tank';
          this.equipment.push({
            type,
            x,
            y: roofY,
            z,
            sx: tank ? Math.min(sx, sz) * 0.6 : type === 'stairhead' ? 3.2 : sx,
            sy: tank ? rng.range(2.4, 3.4) : type === 'stairhead' ? 2.8 : type === 'skylight' ? 0.5 : rng.range(1.1, 2.2),
            sz: tank ? Math.min(sx, sz) * 0.6 : type === 'stairhead' ? 2.6 : sz,
            buildingId: id,
          });
          break;
        }
      }
      if (s.solar && s.w > 8 && s.d > 8) {
        this.equipment.push({ type: 'solar', x: s.cx, y: roofY, z: s.cz, sx: s.w * 0.6, sy: 0.3, sz: s.d * 0.5, buildingId: id });
      }
      if (s.mast) {
        this.equipment.push({
          type: 'mast',
          x: s.cx + rng.range(-s.w / 4, s.w / 4),
          y: roofY,
          z: s.cz + rng.range(-s.d / 4, s.d / 4),
          sx: 0.5,
          sy: 7,
          sz: 0.5,
          buildingId: id,
        });
      }
    }

    if (s.balconies) {
      const floors = Math.floor(s.h / FLOOR_H);
      const alongX = s.w >= s.d;
      const len = alongX ? s.w : s.d;
      const bays = Math.max(1, Math.floor((len - 2) / 4.5));
      const side = rng.chance(0.5) ? -1 : 1;
      for (let f = 2; f < floors; f++) {
        for (let k = 0; k < bays; k++) {
          const t = -len / 2 + 2 + (k + 0.5) * ((len - 4) / bays);
          if (rng.chance(0.3)) continue;
          if (alongX) {
            this.balconies.push({ x: s.cx + t, y: baseY + f * FLOOR_H, z: s.cz + side * (s.d / 2 + 0.7), sx: 2.4, sz: 1.4, rot: 0 });
          } else {
            this.balconies.push({ x: s.cx + side * (s.w / 2 + 0.7), y: baseY + f * FLOOR_H, z: s.cz + t, sx: 2.4, sz: 1.4, rot: Math.PI / 2 });
          }
        }
      }
    }
    return b;
  }
}
