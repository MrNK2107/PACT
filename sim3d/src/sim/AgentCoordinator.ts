import type { Rng } from '../world/rng';
import type { Vec3, WindField } from '../world/types';
import { estimatePct, type EnergyModel } from './Battery';
import { SIM } from './config';
import type { ObstacleManager } from './ObstacleManager';
import type { RadioModel } from './Radio';
import type { NeighborInfo } from './PathPlanner';
import type { DronePhase, Message, SiteStage, Task } from './types';

/**
 * Simulated broadcast radio. A message sent in tick k is delivered at the start of tick k+1 to every
 * agent within `commRange` of the sender's position *at send time*. The bus knows nothing about
 * tasks or avoidance; it is a dumb medium (optionally lossy).
 */
export class MessageBus {
  private pending: { from: string; pos: Vec3; msg: Message }[] = [];
  private inboxes = new Map<string, Message[]>();

  broadcast(from: string, pos: Vec3, msg: Message): void {
    this.pending.push({ from, pos: { ...pos }, msg });
  }

  deliver(agents: { id: string; pos: Vec3 }[], rng: Rng, radio?: RadioModel): void {
    const zoned = !!radio && radio.hasZones;
    for (const p of this.pending) {
      for (const a of agents) {
        if (a.id === p.from) continue;
        const d = Math.hypot(a.pos.x - p.pos.x, a.pos.y - p.pos.y, a.pos.z - p.pos.z);
        // dead zones shrink the range and add loss; with no active zone this is exactly the plain disc model
        const fx = zoned ? radio!.link(p.pos, a.pos) : null;
        if (d > (fx ? SIM.commRange * fx.rangeFactor : SIM.commRange)) continue;
        const loss = fx && fx.loss > 0 ? 1 - (1 - SIM.packetLoss) * (1 - fx.loss) : SIM.packetLoss;
        if (loss > 0 && rng.next() < loss) continue;
        let box = this.inboxes.get(a.id);
        if (!box) this.inboxes.set(a.id, (box = []));
        box.push(p.msg);
      }
    }
    this.pending.length = 0;
  }

  take(id: string): Message[] {
    const box = this.inboxes.get(id);
    if (!box || !box.length) return [];
    this.inboxes.set(id, []);
    return box;
  }

  drop(id: string): void {
    this.inboxes.delete(id);
  }
}

interface NeighborRecord {
  pos: Vec3;
  vel: Vec3;
  intent: Vec3;
  priority: number;
  phase: DronePhase;
  site: Vec3 | null;
  stage: SiteStage | null;
  t: number;
}

interface ClaimRecord {
  taskId: string;
  cost: number;
  t: number;
}

export interface ClaimAttempt {
  task: Task;
  cost: number;
  startedAt: number;
}

/** Total order shared by both ends of a conflict: higher priority wins, ties go to the lower id. */
export function beats(aP: number, aId: string, bP: number, bId: string): boolean {
  return aP !== bP ? aP > bP : aId < bId;
}

/**
 * Per-agent coordination state: neighbour discovery (from received heartbeats), decentralised task
 * allocation (bid / claim / back-off against neighbours within radio range) and site-occupancy etiquette.
 * Each drone owns one instance and only ever reads what it received over the radio.
 */
export class AgentCoordinator {
  private table = new Map<string, NeighborRecord>();
  private claims = new Map<string, ClaimRecord>();
  attempt: ClaimAttempt | null = null;
  private lastHeartbeat = -Infinity;

  constructor(readonly id: string) {}

  ingest(inbox: Message[], now: number): void {
    for (const m of inbox) {
      if (m.type === 'HEARTBEAT') {
        this.table.set(m.from, { pos: m.pos, vel: m.vel, intent: m.intent, priority: m.priority, phase: m.phase, site: m.site, stage: m.stage, t: m.t });
      } else {
        this.claims.set(m.from, { taskId: m.taskId, cost: m.cost, t: m.t });
      }
    }
    for (const [id, r] of this.table) if (now - r.t > SIM.neighborTimeout) this.table.delete(id);
    for (const [id, c] of this.claims) if (now - c.t > 1.5) this.claims.delete(id);
  }

  get neighborCount(): number {
    return this.table.size;
  }

  /** Neighbour table with positions dead-reckoned to `now`. Stable (sorted) order for determinism. */
  neighbors(now: number): NeighborInfo[] {
    const out: NeighborInfo[] = [];
    for (const id of [...this.table.keys()].sort()) {
      const r = this.table.get(id)!;
      const dt = now - r.t;
      out.push({ id, pos: { x: r.pos.x + r.vel.x * dt, y: r.pos.y + r.vel.y * dt, z: r.pos.z + r.vel.z * dt }, vel: r.intent, priority: r.priority });
    }
    return out;
  }

  heartbeatDue(now: number): boolean {
    if (now - this.lastHeartbeat >= SIM.heartbeatPeriod - 1e-9) {
      this.lastHeartbeat = now;
      return true;
    }
    return false;
  }

  // ---- decentralised task allocation -----------------------------------------------------------------

  /** Neighbours heading home to a pad (charging contention signal, 03 section 3.7). */
  returningNeighbours(): number {
    let n = 0;
    for (const r of this.table.values()) if (r.phase === 'returning' || r.phase === 'charging') n++;
    return n;
  }

  /**
   * Bundle-phase scoring (03 section 3.4, B = 1): priority reward minus distance, lateness, energy and
   * charging-contention penalties, under hard payload / energy-reserve constraints. The broadcast CLAIM
   * carries `cost = -score`, so the existing "lower cost wins, ties to the lower id" consensus applies.
   */
  chooseTask(
    open: readonly Task[],
    ctx: { pos: Vec3; battery: number; capacityKg: number; now: number; energy: EnergyModel; wind: WindField; homePad: Vec3; socReserve: number; obstacles: ObstacleManager },
  ): { task: Task; cost: number; score: number; needPct: number } | null {
    const taken = new Set([...this.claims.values()].map((c) => c.taskId));
    const contention = this.returningNeighbours();
    let best: { task: Task; cost: number; score: number; needPct: number } | null = null;
    for (const t of open) {
      if (taken.has(t.task_id)) continue;
      if (t.weight_kg > ctx.capacityKg + 1e-9) continue;
      // route must avoid closed airspace: a pickup or drop inside an active zone is not feasible
      if (ctx.obstacles.inActiveNoFly(t.pickup.x, t.pickup.z, 2) || ctx.obstacles.inActiveNoFly(t.drop.x, t.drop.z, 2)) continue;
      const leg1 = dist(ctx.pos, t.pickup);
      const leg2 = dist(t.pickup, t.drop);
      const needPct = estimatePct(ctx.energy, ctx.wind, [
        { from: ctx.pos, to: t.pickup, payloadKg: 0 },
        { from: t.pickup, to: t.drop, payloadKg: t.weight_kg },
        { from: t.drop, to: ctx.homePad, payloadKg: 0 },
      ], SIM.loadTime + SIM.unloadTime + 10);
      if (ctx.battery < needPct + ctx.socReserve * 100) continue; // I5: reserve + reach-a-pad
      const eta = ctx.now + (leg1 + leg2) / SIM.cruiseSpeed + SIM.loadTime + 20;
      const late = Math.max(0, eta - t.deadline) / 60;
      const score = SIM.w.pri * (4 - t.priority) - SIM.w.dist * ((leg1 + leg2) / 1000) - SIM.w.late * late - SIM.w.energy * (needPct / 100) - SIM.w.pad * contention * 0.25;
      const cost = -score;
      if (!best || cost < best.cost - 1e-6 || (Math.abs(cost - best.cost) < 1e-6 && t.task_id < best.task.task_id)) best = { task: t, cost, score, needPct };
    }
    return best;
  }

  startClaim(task: Task, cost: number, now: number): Message {
    this.attempt = { task, cost, startedAt: now };
    return { type: 'CLAIM', from: this.id, taskId: task.task_id, cost, t: now };
  }

  /** True if a neighbour is bidding for the same task with a better (lower) cost. */
  outbid(): boolean {
    if (!this.attempt) return false;
    for (const [from, c] of this.claims) {
      if (c.taskId !== this.attempt.task.task_id) continue;
      if (c.cost < this.attempt.cost - 1e-6 || (Math.abs(c.cost - this.attempt.cost) < 1e-6 && from < this.id)) return true;
    }
    return false;
  }

  claimWindowElapsed(now: number): boolean {
    return !!this.attempt && now - this.attempt.startedAt >= SIM.claimWindow;
  }

  endClaim(): void {
    this.attempt = null;
  }

  // ---- site etiquette ---------------------------------------------------------------------------------

  /**
   * A site is considered occupied if a neighbour is working/landing on it, or is also on approach and
   * outranks me. Evaluated from heartbeat data only.
   */
  siteOccupied(site: Vec3, myPriority: number, myAlt: number, now: number): boolean {
    for (const [id, r] of this.table) {
      // 1) anyone physically in the column above the site, below my approach altitude (e.g. climbing out)
      const dt = now - r.t;
      const px = r.pos.x + r.vel.x * dt;
      const pz = r.pos.z + r.vel.z * dt;
      const py = r.pos.y + r.vel.y * dt;
      const inColumn = Math.hypot(px - site.x, pz - site.z) < 6 && py < myAlt + 6;
      if (inColumn && r.stage !== 'approach') return true;
      // 2) neighbours targeting the same site
      if (!r.site) continue;
      if (Math.hypot(r.site.x - site.x, r.site.z - site.z) > 4) continue;
      if (r.stage === 'land' || r.stage === 'work') return true;
      if (r.stage === 'approach' && beats(r.priority, id, myPriority, this.id)) return true;
    }
    return false;
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
