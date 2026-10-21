import { scoreTask, type ScoreContext } from './AgentCoordinator';
import type { Task } from './Task';

/** What the hub knows about one idle drone. A central hub sees the whole fleet: no radio range applies. */
export interface HubDrone {
  id: string;
  ctx: ScoreContext;
}

export interface Assignment {
  droneId: string;
  taskId: string;
  score: number;
}

/**
 * Global greedy assignment (the "Hungarian / greedy global" central planner of TC-11): score every feasible
 * (drone, task) pair with the same bid function the PACT drones use, then repeatedly take the best remaining pair.
 * Pure and deterministic: ties go to the lower task id, then the lower drone id.
 */
export function assignGreedy(drones: readonly HubDrone[], open: readonly Task[]): Assignment[] {
  const pairs: Assignment[] = [];
  for (const d of drones) {
    for (const t of open) {
      const sc = scoreTask(t, d.ctx, 0);
      if (sc) pairs.push({ droneId: d.id, taskId: t.task_id, score: sc.score });
    }
  }
  pairs.sort((a, b) => b.score - a.score || cmp(a.taskId, b.taskId) || cmp(a.droneId, b.droneId));
  const usedD = new Set<string>();
  const usedT = new Set<string>();
  const out: Assignment[] = [];
  for (const p of pairs) {
    if (usedD.has(p.droneId) || usedT.has(p.taskId)) continue;
    usedD.add(p.droneId);
    usedT.add(p.taskId);
    out.push(p);
  }
  return out;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read-only view a drone controller gets of the hub (its dispatch channel). */
export interface HubView {
  /** The task the hub assigned to this drone, or null (no assignment, or the hub is down). */
  assignmentFor(droneId: string): Assignment | null;
  /** Called by the drone when it acted on (or rejected) its assignment. */
  consume(droneId: string): void;
}

/**
 * The central hub service for the `central_*` baselines. It plans every `periodS` of sim time; `kill()` takes it
 * down for good (the `kill_service(central_hub)` fault). Dispatches already handed out stay valid, so drones finish
 * what they hold.
 */
export class CentralHub implements HubView {
  alive = true;
  killedAt: number | null = null;
  private nextPlan = 0;
  private assignments = new Map<string, Assignment>();
  plans = 0;

  constructor(private periodS: number) {}

  due(now: number): boolean {
    return this.alive && now >= this.nextPlan - 1e-9;
  }

  plan(now: number, drones: readonly HubDrone[], open: readonly Task[]): Assignment[] {
    this.nextPlan = now + this.periodS;
    this.plans++;
    this.assignments.clear();
    const out = assignGreedy(drones, open);
    for (const a of out) this.assignments.set(a.droneId, a);
    return out;
  }

  kill(now: number): void {
    if (!this.alive) return;
    this.alive = false;
    this.killedAt = now;
    this.assignments.clear();
  }

  assignmentFor(droneId: string): Assignment | null {
    return this.alive ? (this.assignments.get(droneId) ?? null) : null;
  }

  consume(droneId: string): void {
    this.assignments.delete(droneId);
  }
}
