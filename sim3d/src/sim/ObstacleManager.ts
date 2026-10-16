import { isCap, pointInShape, shapeBounds, shapeDistance } from '../world/NoFly';
import type { DynamicObstacleDef, NoFlyZone, StaticObstacle, Vec3, WorldBounds, WorldData } from '../world/types';

export interface DynamicObstacle {
  id: string;
  name: string;
  radius: number;
  pos: Vec3;
  vel: Vec3;
  def: DynamicObstacleDef;
}

const CELL = 20;

/**
 * Owns collision volumes. Static obstacles are indexed in a spatial hash; dynamic obstacles follow
 * deterministic parametric motion driven by simulation time; no-fly zones can be opened / closed at
 * runtime (`close_zone` fault) — only *active* zones constrain flight. Pure data — no rendering here.
 */
export class ObstacleManager {
  readonly statics: StaticObstacle[];
  readonly dynamics: DynamicObstacle[];
  /** Every zone, including inactive (closable) ones. */
  readonly allNoFly: NoFlyZone[];
  readonly bounds: WorldBounds;
  /** Bumped whenever a zone changes state; planners drop cached occupancy. */
  zoneVersion = 0;
  private hash = new Map<number, StaticObstacle[]>();
  private stamp = new Map<string, number>();
  private stampCounter = 0;
  private active: NoFlyZone[] = [];
  private capSig = '';
  /** Bumped whenever the set of active altitude ceilings changes. */
  capVersion = 0;

  constructor(world: WorldData) {
    this.statics = world.obstacles;
    this.allNoFly = world.noFlyZones;
    this.bounds = world.bounds;
    this.refreshActive();
    for (const o of this.statics) {
      const b = o.bounds;
      for (let i = Math.floor(b.minX / CELL); i <= Math.floor(b.maxX / CELL); i++) {
        for (let j = Math.floor(b.minZ / CELL); j <= Math.floor(b.maxZ / CELL); j++) {
          const k = this.key(i, j);
          let list = this.hash.get(k);
          if (!list) this.hash.set(k, (list = []));
          list.push(o);
        }
      }
    }
    this.dynamics = world.dynamicObstacles.map((def) => ({
      id: def.id,
      name: def.name,
      radius: def.radius,
      pos: { x: 0, y: 0, z: 0 },
      vel: { x: 0, y: 0, z: 0 },
      def,
    }));
    this.step(0);
  }

  /** Active no-fly zones (the ones that constrain flight right now). */
  get noFly(): readonly NoFlyZone[] {
    return this.active;
  }

  private refreshActive(): void {
    this.active = this.allNoFly.filter((z) => z.active);
    const sig = this.active.filter(isCap).map((z) => `${z.id}:${z.minY}`).join('|');
    if (sig !== this.capSig) {
      this.capSig = sig;
      this.capVersion++;
    }
  }

  /** Lowest ceiling over (x, z) from active altitude caps, or Infinity. */
  ceilingAt(x: number, z: number): number {
    let c = Infinity;
    for (const n of this.active) if (isCap(n) && n.minY! < c && pointInShape(n.shape, x, z)) c = n.minY!;
    return c;
  }

  /** Moves a zone (a storm cell drifting); planners re-rasterise on the next query. */
  updateZoneShape(id: string, shape: NoFlyZone['shape']): boolean {
    const z = this.allNoFly.find((q) => q.id === id);
    if (!z) return false;
    z.shape = shape;
    this.refreshActive();
    this.zoneVersion++;
    return true;
  }

  /** Open / close a zone (fault injection). Returns false if the zone is unknown. */
  setZoneActive(id: string, active: boolean, t?: number, until?: number): boolean {
    const z = this.allNoFly.find((q) => q.id === id);
    if (!z) return false;
    if (z.active === active) return true;
    z.active = active;
    if (active) {
      z.closedFrom = t;
      z.closedUntil = until;
    } else {
      z.closedFrom = undefined;
      z.closedUntil = undefined;
    }
    this.refreshActive();
    this.zoneVersion++;
    return true;
  }

  /** Add a zone at runtime (e.g. a scenario fault closes a polygon). */
  addZone(z: NoFlyZone): void {
    this.allNoFly.push(z);
    this.refreshActive();
    this.zoneVersion++;
  }

  /** Re-open zones whose closure window has elapsed. */
  expireZones(t: number): void {
    let changed = false;
    for (const z of this.allNoFly) {
      if (z.active && z.closable && z.closedUntil !== undefined && t >= z.closedUntil) {
        z.active = false;
        z.closedFrom = undefined;
        z.closedUntil = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.refreshActive();
      this.zoneVersion++;
    }
  }

  private key(i: number, j: number): number {
    return (i + 4096) * 8192 + (j + 4096);
  }

  /** Update dynamic obstacle positions/velocities for absolute simulation time `t`. */
  step(t: number): void {
    for (const d of this.dynamics) {
      const m = d.def.motion;
      if (m.type === 'orbit') {
        const w = m.speed / m.r;
        const a = m.phase + w * t;
        d.pos.x = m.cx + m.r * Math.cos(a);
        d.pos.z = m.cz + m.r * Math.sin(a);
        d.pos.y = m.y;
        d.vel.x = -m.speed * Math.sin(a);
        d.vel.z = m.speed * Math.cos(a);
        d.vel.y = 0;
      } else {
        const dx = m.bx - m.ax;
        const dz = m.bz - m.az;
        const L = Math.hypot(dx, dz);
        const s = (m.speed * t) % (2 * L);
        const fwd = s < L;
        const u = (fwd ? s : 2 * L - s) / L;
        d.pos.x = m.ax + dx * u;
        d.pos.z = m.az + dz * u;
        d.pos.y = m.y;
        const sign = fwd ? 1 : -1;
        d.vel.x = (dx / L) * m.speed * sign;
        d.vel.z = (dz / L) * m.speed * sign;
        d.vel.y = 0;
      }
    }
  }

  /** Static obstacles whose bounding box may be within `r` of (x,z). Result array is reused per call. */
  queryStatic(x: number, z: number, r: number, out: StaticObstacle[] = []): StaticObstacle[] {
    return this.queryAABB(x - r, x + r, z - r, z + r, out);
  }

  /** Static obstacles whose bounding box overlaps the rectangle. */
  queryAABB(minX: number, maxX: number, minZ: number, maxZ: number, out: StaticObstacle[] = []): StaticObstacle[] {
    out.length = 0;
    const sc = ++this.stampCounter;
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
      for (let j = Math.floor(minZ / CELL); j <= Math.floor(maxZ / CELL); j++) {
        const list = this.hash.get(this.key(i, j));
        if (!list) continue;
        for (const o of list) {
          if (this.stamp.get(o.id) === sc) continue;
          this.stamp.set(o.id, sc);
          const b = o.bounds;
          if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
          out.push(o);
        }
      }
    }
    return out;
  }

  /** Closest point on obstacle volume to p. */
  closestPoint(o: StaticObstacle, p: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
    const b = o.bounds;
    out.y = Math.min(Math.max(p.y, b.minY), b.maxY);
    if (o.shape === 'box') {
      out.x = Math.min(Math.max(p.x, b.minX), b.maxX);
      out.z = Math.min(Math.max(p.z, b.minZ), b.maxZ);
    } else {
      const dx = p.x - o.cx;
      const dz = p.z - o.cz;
      const d = Math.hypot(dx, dz);
      if (d <= o.r) {
        out.x = p.x;
        out.z = p.z;
      } else {
        out.x = o.cx + (dx / d) * o.r;
        out.z = o.cz + (dz / d) * o.r;
      }
    }
    return out;
  }

  /** Signed horizontal distance to no-fly boundary (negative = inside) plus outward normal. */
  noFlyDistance(z: NoFlyZone, x: number, zz: number): { d: number; nx: number; nz: number } {
    return shapeDistance(z.shape, x, zz);
  }

  /** True if (x,z) is inside an active zone (inflated by `margin`). */
  inActiveNoFly(x: number, z: number, margin = 0): boolean {
    for (const n of this.active) if (!isCap(n) && pointInShape(n.shape, x, z, margin)) return true;
    return false;
  }

  /** Active zones whose bounds overlap the rectangle. */
  zonesInAABB(minX: number, maxX: number, minZ: number, maxZ: number): NoFlyZone[] {
    const out: NoFlyZone[] = [];
    for (const n of this.active) {
      const b = shapeBounds(n.shape);
      if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ) continue;
      out.push(n);
    }
    return out;
  }

  /** True if a point at (x, y, z) is inside a solid static obstacle volume (shrunk by `shrink`). */
  insideSolid(p: Vec3, shrink = 0, categories?: StaticObstacle['category'][]): StaticObstacle | null {
    const list = this.queryStatic(p.x, p.z, 1);
    for (const o of list) {
      if (categories && !categories.includes(o.category)) continue;
      const b = o.bounds;
      if (p.y < b.minY + shrink || p.y > b.maxY - shrink) continue;
      if (o.shape === 'box') {
        if (p.x > b.minX + shrink && p.x < b.maxX - shrink && p.z > b.minZ + shrink && p.z < b.maxZ - shrink) return o;
      } else if ((p.x - o.cx) ** 2 + (p.z - o.cz) ** 2 < (o.r - shrink) ** 2) return o;
    }
    return null;
  }
}
