import type { Vec3, WindField } from '../world/types';
import { estimatePct, type EnergyModel } from './Battery';
import { SIM } from './config';
import type { ObstacleManager } from './ObstacleManager';
import type { NeighborInfo } from './PathPlanner';
import type { DronePhase, Message, SiteStage, Task } from './types';

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

  /** Ids of the drones I can currently hear (radio neighbour table). */
  heardIds(): Set<string> {
    return new Set(this.table.keys());
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
  chooseTask(open: readonly Task[], ctx: ScoreContext, distrust?: (peer: string) => boolean): { task: Task; cost: number; score: number; needPct: number } | null {
    const taken = new Set<string>();
    for (const [from, c] of this.claims) if (!distrust?.(from)) taken.add(c.taskId);
    const contention = this.returningNeighbours();
    let best: { task: Task; cost: number; score: number; needPct: number } | null = null;
    for (const t of open) {
      if (taken.has(t.task_id)) continue;
      const sc = scoreTask(t, ctx, contention);
      if (!sc) continue;
      const cost = -sc.score;
      if (!best || cost < best.cost - 1e-6 || (Math.abs(cost - best.cost) < 1e-6 && t.task_id < best.task.task_id)) best = { task: t, cost, score: sc.score, needPct: sc.needPct };
    }
    return best;
  }

  /**
   * `greedy_nearest` baseline (REQ-EVAL-001 c): the closest feasible task (pickup + drop distance), ignoring
   * priority, deadline and neighbours' bids. Same hard constraints as the PACT bid, so the baseline is not
   * handicapped on energy safety.
   */
  chooseNearest(open: readonly Task[], ctx: ScoreContext): { task: Task; cost: number } | null {
    let best: { task: Task; cost: number } | null = null;
    for (const t of open) {
      if (!scoreTask(t, ctx, 0)) continue;
      const cost = (dist(ctx.pos, t.pickup) + dist(t.pickup, t.drop)) / 1000;
      if (!best || cost < best.cost - 1e-6 || (Math.abs(cost - best.cost) < 1e-6 && t.task_id < best.task.task_id)) best = { task: t, cost };
    }
    return best;
  }

  startClaim(task: Task, cost: number, now: number): Message {
    this.attempt = { task, cost, startedAt: now };
    return { type: 'CLAIM', from: this.id, taskId: task.task_id, cost, t: now };
  }

  /**
   * True if a neighbour is bidding for the same task with a better (lower) cost. Bids from peers in `distrust`
   * (suspected by my failure detector) do not count: a suspect gets no new work (docs/P2P_DESIGN.md section 7).
   */
  outbid(distrust?: (peer: string) => boolean): boolean {
    if (!this.attempt) return false;
    for (const [from, c] of this.claims) {
      if (c.taskId !== this.attempt.task.task_id) continue;
      if (distrust?.(from)) continue;
      if (c.cost < this.attempt.cost - 1e-6 || (Math.abs(c.cost - this.attempt.cost) < 1e-6 && from < this.id)) return true;
    }
    return false;
  }

  /** The claim window (stretched to the scenario's latency bound, `SIM.claimWait`) has passed. */
  claimWindowElapsed(now: number): boolean {
    return !!this.attempt && now - this.attempt.startedAt >= SIM.claimWait;
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

/** What a drone (or the central planner, on its behalf) knows when it scores a task. */
export interface ScoreContext {
  pos: Vec3;
  battery: number;
  capacityKg: number;
  now: number;
  energy: EnergyModel;
  wind: WindField;
  homePad: Vec3;
  socReserve: number;
  obstacles: ObstacleManager;
}

/**
 * Bid score of one task for one drone (03 section 3.4, B = 1), or null when a hard constraint rules it out:
 * payload over capacity, pickup or drop in closed airspace, or pessimistic energy below reserve + reach-a-pad (I5).
 * Shared by the PACT auction and the central planner baselines so every system ranks tasks the same way.
 */
export function scoreTask(t: Task, ctx: ScoreContext, contention: number): { score: number; needPct: number } | null {
  if (t.weight_kg > ctx.capacityKg + 1e-9) return null;
  if (ctx.obstacles.inActiveNoFly(t.pickup.x, t.pickup.z, 2) || ctx.obstacles.inActiveNoFly(t.drop.x, t.drop.z, 2)) return null;
  const leg1 = dist(ctx.pos, t.pickup);
  const leg2 = dist(t.pickup, t.drop);
  const needPct = estimatePct(ctx.energy, ctx.wind, [
    { from: ctx.pos, to: t.pickup, payloadKg: 0 },
    { from: t.pickup, to: t.drop, payloadKg: t.weight_kg },
    { from: t.drop, to: ctx.homePad, payloadKg: 0 },
  ], SIM.loadTime + SIM.unloadTime + 10);
  if (ctx.battery < needPct + ctx.socReserve * 100) return null;
  const eta = ctx.now + (leg1 + leg2) / SIM.cruiseSpeed + SIM.loadTime + 20;
  const late = Math.max(0, eta - t.deadline) / 60;
  const score = SIM.w.pri * (4 - t.priority) - SIM.w.dist * ((leg1 + leg2) / 1000) - SIM.w.late * late - SIM.w.energy * (needPct / 100) - SIM.w.pad * contention * 0.25;
  return { score, needPct };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
