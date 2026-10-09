import type { Scenario, ScriptedTaskSpec } from '../scenario/types';
import { PRIORITY_AFFINITY } from '../world/DropPoints';
import type { Rng } from '../world/rng';
import { shardOf } from '../world/Shards';
import type { DemandCluster, DepotData, DropPointData, DropType, WorldData } from '../world/types';
import { makeTaskId, type Priority, type Task } from './Task';

/**
 * Workload generator (REQ-SIM-005): Poisson arrivals, clustered demand (clusters weighted by their
 * demand and their affinity for the sampled priority), priority mix, per-priority deadline
 * distributions and a log-normal weight distribution. Scripted tasks from the scenario are merged in
 * time order. Fully deterministic given the seeded RNG.
 */
export interface TaskRequest {
  priority?: Priority;
  clusterType?: DropType;
  dropId?: string;
  dropPos?: { x: number; z: number };
  originDepot?: string;
  deadlineOffset?: number;
  weightKg?: number;
  taskId?: string;
  scripted?: boolean;
}

export class WorkloadGenerator {
  private nextArrival: number;
  private scripted: { t: number; spec: ScriptedTaskSpec }[];
  private scriptedIdx = 0;
  private bursts: { t: number; req: TaskRequest }[] = [];
  private readonly depotsById: Map<string, DepotData>;
  private readonly dropsById: Map<string, DropPointData>;
  private readonly clusters: DemandCluster[];
  generated = 0;

  constructor(
    private world: WorldData,
    private scenario: Scenario,
    private rng: Rng,
  ) {
    this.depotsById = new Map(world.depots.map((d) => [d.id, d]));
    this.dropsById = new Map(world.dropPoints.map((d) => [d.id, d]));
    this.clusters = world.clusters.filter((c) => c.pointIds.length > 0);
    this.scripted = scenario.workload.tasks.map((spec) => ({ t: spec.t, spec })).sort((a, b) => a.t - b.t);
    this.nextArrival = this.sampleInterval(0);
  }

  private get lambda(): number {
    return this.scenario.workload.arrival_rate_per_min / 60;
  }

  /** Exponential inter-arrival; `now` is only used when the rate is zero. */
  private sampleInterval(now: number): number {
    const l = this.lambda;
    if (l <= 0) return Infinity;
    return now + -Math.log(1 - this.rng.next()) / l;
  }

  /** Tasks whose arrival time has passed (generated, scripted and burst), in time order. */
  step(now: number): Task[] {
    const out: Task[] = [];
    while (this.nextArrival <= now) {
      out.push(this.makeTask(this.nextArrival, {}));
      this.nextArrival = this.sampleInterval(this.nextArrival);
      if (!isFinite(this.nextArrival)) break;
    }
    while (this.scriptedIdx < this.scripted.length && this.scripted[this.scriptedIdx].t <= now) {
      const { t, spec } = this.scripted[this.scriptedIdx++];
      out.push(this.makeTask(t, { priority: spec.priority, clusterType: spec.cluster_type, dropId: spec.drop_id, dropPos: spec.drop ? { x: spec.drop.x, z: spec.drop.y } : undefined, originDepot: spec.origin_depot, deadlineOffset: spec.deadline_offset_s, weightKg: spec.weight_kg, taskId: spec.task_id, scripted: true }));
    }
    const due = this.bursts.filter((b) => b.t <= now).sort((a, b) => a.t - b.t);
    if (due.length) {
      this.bursts = this.bursts.filter((b) => b.t > now);
      for (const b of due) out.push(this.makeTask(b.t, b.req));
    }
    out.sort((a, b) => a.created_at - b.created_at);
    return out;
  }

  /** `urgent_job_burst`: n tasks spread uniformly over `windowS` seconds from `now`. */
  burst(n: number, priority: Priority, windowS: number, now: number, clusterType?: DropType): void {
    for (let i = 0; i < n; i++) this.bursts.push({ t: now + this.rng.range(0, windowS), req: { priority, clusterType } });
  }

  // ---- sampling ------------------------------------------------------------------------------------------

  private samplePriority(): Priority {
    const mix = this.scenario.workload.priority_mix;
    const r = this.rng.next();
    return r < mix[0] ? 1 : r < mix[0] + mix[1] ? 2 : 3;
  }

  private sampleCluster(priority: Priority, type?: DropType): DemandCluster {
    const pool = type ? this.clusters.filter((c) => c.type === type) : this.clusters;
    const list = pool.length ? pool : this.clusters;
    let total = 0;
    for (const c of list) total += c.demand * PRIORITY_AFFINITY[c.type][priority - 1];
    let r = this.rng.next() * total;
    for (const c of list) {
      r -= c.demand * PRIORITY_AFFINITY[c.type][priority - 1];
      if (r <= 0) return c;
    }
    return list[list.length - 1];
  }

  private samplePoint(c: DemandCluster): DropPointData {
    let total = 0;
    const pts = c.pointIds.map((id) => this.dropsById.get(id)!);
    for (const p of pts) total += p.demand;
    let r = this.rng.next() * total;
    for (const p of pts) {
      r -= p.demand;
      if (r <= 0) return p;
    }
    return pts[pts.length - 1];
  }

  private nearestDrop(x: number, z: number): DropPointData {
    let best = this.world.dropPoints[0];
    let bd = Infinity;
    for (const d of this.world.dropPoints) {
      const dd = (d.pos.x - x) ** 2 + (d.pos.z - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = d;
      }
    }
    return best;
  }

  /** Box–Muller normal from the seeded RNG. */
  private normal(): number {
    const u = Math.max(1e-9, this.rng.next());
    const v = this.rng.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  makeTask(now: number, req: TaskRequest): Task {
    const priority = req.priority ?? this.samplePriority();
    let drop: DropPointData | undefined = req.dropId ? this.dropsById.get(req.dropId) : undefined;
    if (!drop && req.dropPos) drop = this.nearestDrop(req.dropPos.x, req.dropPos.z);
    if (!drop) drop = this.samplePoint(this.sampleCluster(priority, req.clusterType));
    // origin: the drop's catchment depot most of the time, otherwise a random depot (cross-town traffic)
    let depot = req.originDepot ? this.depotsById.get(req.originDepot) : undefined;
    if (!depot) depot = this.rng.chance(0.85) ? this.depotsById.get(drop.nearestDepotId) : this.rng.pick(this.world.depots);
    if (!depot) depot = this.world.depots[0];
    const bay = this.rng.pick(depot.handoff);
    const dl = this.scenario.workload.deadline_s[priority];
    const deadline = now + (req.deadlineOffset ?? this.rng.range(dl[0], dl[1]));
    const wcfg = this.scenario.workload.weight_kg;
    const cap = this.scenario.fleet.capacity_kg;
    const weight = req.weightKg ?? Math.min(cap, Math.max(0.2, Math.exp(Math.log(wcfg.median) + wcfg.sigma * this.normal())));
    const task: Task = {
      task_id: req.taskId ?? makeTaskId(depot.id, now, this.rng),
      origin_depot: depot.id,
      pickup: { x: bay.x, y: bay.y, z: bay.z },
      drop: { x: drop.pos.x, y: drop.pos.y, z: drop.pos.z },
      priority,
      deadline,
      weight_kg: Math.round(weight * 100) / 100,
      shard: drop.shard || shardOf(this.world.shards, drop.pos.x, drop.pos.z),
      state: 'UNASSIGNED',
      epoch: 0,
      owner: null,
      bid: null,
      lease_ttl: null,
      created_at: now,
      dropId: drop.id,
      type: drop.type,
      scripted: !!req.scripted,
    };
    this.generated++;
    return task;
  }
}
