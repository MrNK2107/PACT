import { pointInShape, shapeBounds } from '../world/NoFly';
import type { StaticObstacle, Vec3, WorldBounds } from '../world/types';
import { SIM } from './config';
import { ObstacleManager } from './ObstacleManager';

export type WaypointKind = 'climb' | 'cruise' | 'approach' | 'land';

export interface Waypoint {
  pos: Vec3;
  kind: WaypointKind;
}

export interface RoutePlan {
  waypoints: Waypoint[];
  cruiseAlt: number;
  length: number;
}

const CELL = 2.5;
const INFLATE = 3.5;
const V_MARGIN = 6;
const BARRIER_RANGE = 14;
/** Occupancy is rasterised lazily in square chunks of CHUNK x CHUNK cells (250 m). */
const CHUNK = 100;
const MAX_CHUNKS = 1024;

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(k: number, v: number) {
    const ks = this.keys;
    const vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p] <= ks[i]) break;
      [ks[p], ks[i]] = [ks[i], ks[p]];
      [vs[p], vs[i]] = [vs[i], vs[p]];
      i = p;
    }
  }
  pop(): number {
    const ks = this.keys;
    const vs = this.vals;
    const top = vs[0];
    const lk = ks.pop()!;
    const lv = vs.pop()!;
    if (ks.length) {
      ks[0] = lk;
      vs[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < ks.length && ks[l] < ks[m]) m = l;
        if (r < ks.length && ks[r] < ks[m]) m = r;
        if (m === i) break;
        [ks[m], ks[i]] = [ks[i], ks[m]];
        [vs[m], vs[i]] = [vs[i], vs[m]];
        i = m;
      }
    }
    return top;
  }
}

/** A rectangular occupancy window (1 = blocked) in grid-cell coordinates. */
export interface OccupancyWindow {
  i0: number;
  j0: number;
  nx: number;
  nz: number;
  grid: Uint8Array;
}

/**
 * Global-ish waypoint planner over the a-priori static map (buildings, cranes, utilities, active
 * no-fly zones). Plans a 2.5D route: vertical climb, a constant-altitude cruise leg found by A* on an
 * occupancy grid specific to that altitude, then a vertical descent. Occupancy is rasterised lazily
 * per 250 m chunk and cached, and A* runs inside a window around the two endpoints, so maps of any
 * size cost memory proportional to the area actually flown. Every drone owns its plans; nothing here
 * coordinates drones with each other.
 */
export class PathPlanner {
  readonly cell = CELL;
  readonly nx: number;
  readonly nz: number;
  private chunks = new Map<string, Uint8Array>();
  private order: string[] = [];
  private zoneVersionSeen: number;
  private scratch: StaticObstacle[] = [];

  constructor(
    private obs: ObstacleManager,
    private bounds: WorldBounds,
  ) {
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / CELL);
    this.nz = Math.ceil((bounds.maxZ - bounds.minZ) / CELL);
    this.zoneVersionSeen = obs.zoneVersion;
  }

  private sync(): void {
    if (this.obs.zoneVersion !== this.zoneVersionSeen) {
      this.chunks.clear();
      this.order.length = 0;
      this.zoneVersionSeen = this.obs.zoneVersion;
    }
  }

  /** Occupancy for the chunk (ci, cj) at altitude key `alt` (1 = blocked). */
  private chunk(alt: number, ci: number, cj: number): Uint8Array {
    const key = `${alt}:${ci}:${cj}`;
    const hit = this.chunks.get(key);
    if (hit) return hit;
    const { bounds } = this;
    const g = new Uint8Array(CHUNK * CHUNK);
    const i0 = ci * CHUNK;
    const j0 = cj * CHUNK;
    const minX = bounds.minX + i0 * CELL;
    const minZ = bounds.minZ + j0 * CELL;
    const maxX = minX + CHUNK * CELL;
    const maxZ = minZ + CHUNK * CELL;
    const rasterBox = (bx0: number, bx1: number, bz0: number, bz1: number) => {
      const a0 = Math.max(0, Math.floor((bx0 - minX) / CELL));
      const a1 = Math.min(CHUNK - 1, Math.floor((bx1 - minX) / CELL));
      const b0 = Math.max(0, Math.floor((bz0 - minZ) / CELL));
      const b1 = Math.min(CHUNK - 1, Math.floor((bz1 - minZ) / CELL));
      for (let j = b0; j <= b1; j++) for (let i = a0; i <= a1; i++) g[j * CHUNK + i] = 1;
    };
    const rasterCircle = (cx: number, cz: number, r: number) => {
      const a0 = Math.max(0, Math.floor((cx - r - minX) / CELL));
      const a1 = Math.min(CHUNK - 1, Math.floor((cx + r - minX) / CELL));
      const b0 = Math.max(0, Math.floor((cz - r - minZ) / CELL));
      const b1 = Math.min(CHUNK - 1, Math.floor((cz + r - minZ) / CELL));
      for (let j = b0; j <= b1; j++) {
        for (let i = a0; i <= a1; i++) {
          const x = minX + (i + 0.5) * CELL;
          const z = minZ + (j + 0.5) * CELL;
          if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) g[j * CHUNK + i] = 1;
        }
      }
    };
    const pad = INFLATE + 1;
    for (const o of this.obs.queryAABB(minX - pad, maxX + pad, minZ - pad, maxZ + pad, this.scratch)) {
      if (alt < o.bounds.minY - V_MARGIN || alt > o.bounds.maxY + V_MARGIN) continue;
      if (o.shape === 'box') rasterBox(o.bounds.minX - INFLATE, o.bounds.maxX + INFLATE, o.bounds.minZ - INFLATE, o.bounds.maxZ + INFLATE);
      else rasterCircle(o.cx, o.cz, o.r + INFLATE);
    }
    for (const z of this.obs.zonesInAABB(minX - pad, maxX + pad, minZ - pad, maxZ + pad)) {
      if (alt > z.maxY) continue;
      const s = z.shape;
      if (s.type === 'circle') rasterCircle(s.x, s.z, s.r + INFLATE);
      else if (s.type === 'box') rasterBox(s.minX - INFLATE, s.maxX + INFLATE, s.minZ - INFLATE, s.maxZ + INFLATE);
      else {
        const bb = shapeBounds(s);
        const a0 = Math.max(0, Math.floor((bb.minX - INFLATE - minX) / CELL));
        const a1 = Math.min(CHUNK - 1, Math.floor((bb.maxX + INFLATE - minX) / CELL));
        const b0 = Math.max(0, Math.floor((bb.minZ - INFLATE - minZ) / CELL));
        const b1 = Math.min(CHUNK - 1, Math.floor((bb.maxZ + INFLATE - minZ) / CELL));
        for (let j = b0; j <= b1; j++) {
          for (let i = a0; i <= a1; i++) {
            if (pointInShape(s, minX + (i + 0.5) * CELL, minZ + (j + 0.5) * CELL, INFLATE)) g[j * CHUNK + i] = 1;
          }
        }
      }
    }
    // keep a margin inside the world boundary
    const m = 2;
    for (let j = 0; j < CHUNK; j++) {
      for (let i = 0; i < CHUNK; i++) {
        const gi = i0 + i;
        const gj = j0 + j;
        if (gi < m || gj < m || gi >= this.nx - m || gj >= this.nz - m) g[j * CHUNK + i] = 1;
      }
    }
    this.chunks.set(key, g);
    this.order.push(key);
    if (this.order.length > MAX_CHUNKS) this.chunks.delete(this.order.shift()!);
    return g;
  }

  /** Copies occupancy for the cell rectangle [i0, i0+nx) x [j0, j0+nz) out of the chunk cache. */
  blockedWindow(alt: number, i0: number, j0: number, nx: number, nz: number): OccupancyWindow {
    this.sync();
    const key = Math.round(alt);
    const grid = new Uint8Array(nx * nz);
    const c0 = Math.floor(i0 / CHUNK);
    const c1 = Math.floor((i0 + nx - 1) / CHUNK);
    const d0 = Math.floor(j0 / CHUNK);
    const d1 = Math.floor((j0 + nz - 1) / CHUNK);
    for (let cj = d0; cj <= d1; cj++) {
      for (let ci = c0; ci <= c1; ci++) {
        const g = this.chunk(key, ci, cj);
        const ia = Math.max(i0, ci * CHUNK);
        const ib = Math.min(i0 + nx, (ci + 1) * CHUNK);
        const ja = Math.max(j0, cj * CHUNK);
        const jb = Math.min(j0 + nz, (cj + 1) * CHUNK);
        for (let j = ja; j < jb; j++) {
          const src = (j - cj * CHUNK) * CHUNK + (ia - ci * CHUNK);
          grid.set(g.subarray(src, src + (ib - ia)), (j - j0) * nx + (ia - i0));
        }
      }
    }
    return { i0, j0, nx, nz, grid };
  }

  /** Occupancy window covering a world rectangle (for overlays). */
  blockedArea(alt: number, minX: number, maxX: number, minZ: number, maxZ: number): OccupancyWindow {
    const [i0, j0] = this.cellOf(minX, minZ);
    const [i1, j1] = this.cellOf(maxX, maxZ);
    return this.blockedWindow(alt, i0, j0, i1 - i0 + 1, j1 - j0 + 1);
  }

  cellOf(x: number, z: number): [number, number] {
    return [
      Math.min(this.nx - 1, Math.max(0, Math.floor((x - this.bounds.minX) / CELL))),
      Math.min(this.nz - 1, Math.max(0, Math.floor((z - this.bounds.minZ) / CELL))),
    ];
  }

  centre(i: number, j: number): [number, number] {
    return [this.bounds.minX + (i + 0.5) * CELL, this.bounds.minZ + (j + 0.5) * CELL];
  }

  private nearestFree(w: OccupancyWindow, i: number, j: number): [number, number] | null {
    const { grid, nx, nz } = w;
    if (i >= 0 && j >= 0 && i < nx && j < nz && !grid[j * nx + i]) return [i, j];
    for (let r = 1; r <= 14; r++) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
          if (grid[jj * nx + ii]) continue;
          const d = di * di + dj * dj;
          if (d < bd) {
            bd = d;
            best = [ii, jj];
          }
        }
      }
      if (best) return best;
    }
    return null;
  }

  private lineClear(w: OccupancyWindow, ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(d / (CELL * 0.5)));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const [gi, gj] = this.cellOf(ax + (bx - ax) * t, az + (bz - az) * t);
      const i = gi - w.i0;
      const j = gj - w.j0;
      if (i < 0 || j < 0 || i >= w.nx || j >= w.nz) return false;
      if (w.grid[j * w.nx + i]) return false;
    }
    return true;
  }

  private astar(w: OccupancyWindow, si: number, sj: number, gi: number, gj: number): [number, number][] | null {
    const { grid: g, nx, nz } = w;
    const N = nx * nz;
    const gs = new Float32Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const s = sj * nx + si;
    const goal = gj * nx + gi;
    gs[s] = 0;
    const h = (i: number, j: number) => {
      const dx = Math.abs(i - gi);
      const dz = Math.abs(j - gj);
      return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
    };
    heap.push(h(si, sj), s);
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) {
        const out: [number, number][] = [];
        for (let c = cur; c !== -1; c = parent[c]) out.push([c % nx, Math.floor(c / nx)]);
        return out.reverse();
      }
      const ci = cur % nx;
      const cj = Math.floor(cur / nx);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
          const n = nj * nx + ni;
          if (g[n] || closed[n]) continue;
          if (di && dj && (g[cj * nx + ni] || g[nj * nx + ci])) continue;
          const cost = gs[cur] + (di && dj ? 1.4142 : 1);
          if (cost < gs[n]) {
            gs[n] = cost;
            parent[n] = cur;
            heap.push(cost + h(ni, nj), n);
          }
        }
      }
    }
    return null;
  }

  /** Window of cells around the two endpoints, inflated by `margin` metres and clamped to the map. */
  private window(from: Vec3, to: Vec3, margin: number): [number, number, number, number] {
    const minX = Math.min(from.x, to.x) - margin;
    const maxX = Math.max(from.x, to.x) + margin;
    const minZ = Math.min(from.z, to.z) - margin;
    const maxZ = Math.max(from.z, to.z) + margin;
    const [i0, j0] = this.cellOf(minX, minZ);
    const [i1, j1] = this.cellOf(maxX, maxZ);
    return [i0, j0, i1 - i0 + 1, j1 - j0 + 1];
  }

  /**
   * Plan a route between two 3D points. Tries `preferredAlt`, climbing to higher layers if the
   * lower layers are blocked; the search window around the endpoints is widened once before moving
   * up a layer. Returns null only if even the highest layer cannot connect the points.
   */
  plan(from: Vec3, to: Vec3, preferredAlt: number): RoutePlan | null {
    this.sync();
    const base = Math.max(preferredAlt, from.y + 10, to.y + 10);
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    const margins = [Math.max(250, 0.35 * dist), Math.max(600, 0.9 * dist)];
    for (let alt = base; alt <= this.bounds.maxY - 5; alt += 9) {
      for (const margin of margins) {
        const [i0, j0, nx, nz] = this.window(from, to, margin);
        const w = this.blockedWindow(alt, i0, j0, nx, nz);
        const [fi, fj] = this.cellOf(from.x, from.z);
        const [ti, tj] = this.cellOf(to.x, to.z);
        const s = this.nearestFree(w, fi - i0, fj - j0);
        const e = this.nearestFree(w, ti - i0, tj - j0);
        if (!s || !e) continue;
        const cells = this.astar(w, s[0], s[1], e[0], e[1]);
        if (!cells) continue;

        const pts: [number, number][] = [[from.x, from.z]];
        for (const [i, j] of cells) pts.push(this.centre(i + i0, j + j0));
        pts.push([to.x, to.z]);
        // string-pulling
        const sm: [number, number][] = [pts[0]];
        let i = 0;
        while (i < pts.length - 1) {
          let j = pts.length - 1;
          while (j > i + 1 && !this.lineClear(w, pts[i][0], pts[i][1], pts[j][0], pts[j][1])) j--;
          sm.push(pts[j]);
          i = j;
        }

        const wps: Waypoint[] = [];
        if (from.y < alt - 2) wps.push({ pos: { x: from.x, y: alt, z: from.z }, kind: 'climb' });
        for (let k = 1; k < sm.length - 1; k++) wps.push({ pos: { x: sm[k][0], y: alt, z: sm[k][1] }, kind: 'cruise' });
        wps.push({ pos: { x: to.x, y: alt, z: to.z }, kind: 'approach' });
        wps.push({ pos: { x: to.x, y: to.y, z: to.z }, kind: 'land' });
        let length = 0;
        let prev = from;
        for (const wp of wps) {
          length += Math.hypot(wp.pos.x - prev.x, wp.pos.y - prev.y, wp.pos.z - prev.z);
          prev = wp.pos;
        }
        return { waypoints: wps, cruiseAlt: alt, length };
      }
    }
    return null;
  }
}

// ------------------------------------------------------------------------------------------------
// Local (reactive) avoidance
// ------------------------------------------------------------------------------------------------

export interface NeighborInfo {
  id: string;
  pos: Vec3;
  vel: Vec3;
  /** Broadcast priority — both ends evaluate the same total order, so roles are complementary. */
  priority: number;
}

export interface AvoidanceInput {
  id: string;
  pos: Vec3;
  priority: number;
  /** Terminal = climbing out / descending onto a pad; static obstacle & no-fly repulsion is muted. */
  terminal: boolean;
  desired: Vec3;
  maxSpeed: number;
  neighbors: NeighborInfo[];
  obstacles: ObstacleManager;
}

export interface AvoidanceResult {
  velocity: Vec3;
  /** True if the commanded velocity was altered to avoid something. */
  avoiding: boolean;
  /** Ids of neighbours / obstacles currently in conflict with this drone. */
  conflictWith: string[];
  yielding: boolean;
}

const scratch: StaticObstacle[] = [];
const cp: Vec3 = { x: 0, y: 0, z: 0 };

function priorityBeats(aP: number, aId: string, bP: number, bId: string): boolean {
  return aP !== bP ? aP > bP : aId < bId;
}

/**
 * Local avoidance: predicted closest-point-of-approach conflict detection against neighbours learned
 * through communication, with priority-based yielding (right-hand sidestep + retreat + vertical shear
 * when stacked), moving-obstacle avoidance, no-fly boundary repulsion, and a velocity barrier that
 * limits the closing speed towards static obstacles so the drone can always brake in time.
 */
export function computeAvoidance(inp: AvoidanceInput): AvoidanceResult {
  const av: Vec3 = { x: 0, y: 0, z: 0 };
  const conflicts: string[] = [];
  let avoiding = false;
  let yielding = false;
  let speedScale = 1;
  const sep = SIM.separation;
  const V = inp.maxSpeed;

  /** Right-of-bearing sidestep plus retreat, scaled by urgency. */
  const sidestep = (rx: number, rz: number, sideGain: number, retreatGain: number, u: number) => {
    const dh = Math.hypot(rx, rz) || 1e-3;
    const bx = rx / dh;
    const bz = rz / dh;
    av.x += (-bz * sideGain - bx * retreatGain) * V * u;
    av.z += (bx * sideGain - bz * retreatGain) * V * u;
  };

  for (const n of inp.neighbors) {
    const rxv = n.pos.x - inp.pos.x;
    const ryv = (n.pos.y - inp.pos.y) * 1.6;
    const rzv = n.pos.z - inp.pos.z;
    const d = Math.hypot(rxv, ryv, rzv);
    if (d > SIM.senseRange) continue;
    const wx = n.vel.x - inp.desired.x;
    const wy = (n.vel.y - inp.desired.y) * 1.6;
    const wz = n.vel.z - inp.desired.z;
    const ww = wx * wx + wy * wy + wz * wz;
    const tca = ww > 1e-4 ? Math.min(SIM.horizon, Math.max(0, -(rxv * wx + ryv * wy + rzv * wz) / ww)) : 0;
    const dmin = Math.hypot(rxv + wx * tca, ryv + wy * tca, rzv + wz * tca);
    if (dmin >= sep && d >= sep * 0.8) continue;
    conflicts.push(n.id);
    const mustYield = priorityBeats(n.priority, n.id, inp.priority, inp.id);
    const urgency = Math.min(1, Math.max(0.3, 1 - dmin / sep, 1.2 - d / (sep * 1.5)));
    if (mustYield) {
      yielding = true;
      avoiding = true;
      sidestep(rxv, rzv, 0.9, 0.35, urgency);
      const dh = Math.hypot(rxv, rzv);
      if (dh < sep * 0.7 && Math.abs(n.pos.y - inp.pos.y) < 9) {
        // stacked: separate vertically, away from where the other drone will be at closest approach
        const dyp = n.pos.y + n.vel.y * tca - (inp.pos.y + inp.desired.y * tca);
        av.y += (dyp > 0 ? -1 : 1) * SIM.maxVz * 0.8 * urgency;
      }
      speedScale = Math.min(speedScale, 1 - 0.6 * urgency);
    } else {
      // priority holder keeps its route but shares some of the lateral burden when the predicted miss
      // distance is small, and backs off if dangerously close
      if (dmin < sep * 0.7) {
        avoiding = true;
        sidestep(rxv, rzv, 0.4, 0, urgency);
      }
      if (d < sep * 0.6) {
        avoiding = true;
        sidestep(rxv, rzv, 0, 0.5, 1);
      }
    }
  }

  // Moving obstacles (always have right of way)
  for (const o of inp.obstacles.dynamics) {
    const rxv = o.pos.x - inp.pos.x;
    const ryv = o.pos.y - inp.pos.y;
    const rzv = o.pos.z - inp.pos.z;
    const d = Math.hypot(rxv, ryv, rzv);
    const clear = o.radius + 10;
    if (d > SIM.senseRange + o.radius) continue;
    const wx = o.vel.x - inp.desired.x;
    const wy = o.vel.y - inp.desired.y;
    const wz = o.vel.z - inp.desired.z;
    const ww = wx * wx + wy * wy + wz * wz;
    const tca = ww > 1e-4 ? Math.min(SIM.horizon, Math.max(0, -(rxv * wx + ryv * wy + rzv * wz) / ww)) : 0;
    const dmin = Math.hypot(rxv + wx * tca, ryv + wy * tca, rzv + wz * tca);
    if (dmin >= clear && d >= clear) continue;
    conflicts.push(o.id);
    avoiding = true;
    yielding = true;
    const urgency = Math.min(1, Math.max(0.35, 1 - dmin / clear));
    sidestep(rxv, rzv, 1.0, 0.5, urgency);
    speedScale = Math.min(speedScale, 1 - 0.5 * urgency);
  }

  if (!inp.terminal) {
    // No-fly boundaries
    for (const z of inp.obstacles.noFly) {
      if (inp.pos.y > z.maxY) continue;
      const nd = inp.obstacles.noFlyDistance(z, inp.pos.x, inp.pos.z);
      if (nd.d >= SIM.noFlyRange) continue;
      const k = (nd.d < 0 ? 1.6 : ((SIM.noFlyRange - nd.d) / SIM.noFlyRange) * 1.2) * V;
      av.x += nd.nx * k;
      av.z += nd.nz * k;
      avoiding = true;
      if (nd.d < 1) conflicts.push(z.id);
    }
  }

  const v: Vec3 = { x: inp.desired.x * speedScale + av.x, y: inp.desired.y + av.y, z: inp.desired.z * speedScale + av.z };

  if (!inp.terminal) {
    // Static-obstacle velocity barrier: closing speed towards any obstacle must not exceed what the
    // drone can brake from, (d - margin) * 1.2 m/s. Clips only the inward component.
    const list = inp.obstacles.queryStatic(inp.pos.x, inp.pos.z, BARRIER_RANGE + 2, scratch);
    for (const o of list) {
      if (o.category === 'tree' && inp.pos.y > o.bounds.maxY + 1) continue;
      const p = inp.obstacles.closestPoint(o, inp.pos, cp);
      const dx = inp.pos.x - p.x;
      const dy = inp.pos.y - p.y;
      const dz = inp.pos.z - p.z;
      const d = Math.hypot(dx, dy, dz) || 1e-3;
      if (d >= BARRIER_RANGE) continue;
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const vn = v.x * nx + v.y * ny + v.z * nz;
      const allowed = -Math.max(0, d - 3.5) * 1.2;
      if (vn < allowed) {
        v.x += nx * (allowed - vn);
        v.y += ny * (allowed - vn);
        v.z += nz * (allowed - vn);
        avoiding = true;
        if (d < 2.5) conflicts.push(o.id);
      }
    }
  }

  const hs = Math.hypot(v.x, v.z);
  const lim = V * 1.15;
  if (hs > lim) {
    v.x *= lim / hs;
    v.z *= lim / hs;
  }
  v.y = Math.max(-SIM.maxVz, Math.min(SIM.maxVz, v.y));
  return { velocity: v, avoiding, conflictWith: conflicts, yielding };
}
