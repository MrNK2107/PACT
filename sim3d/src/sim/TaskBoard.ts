import { isTerminal, type Priority, type Task, type TaskState } from './Task';
import type { TaskBoardView } from './types';

export interface BoardEvent {
  t: number;
  type: 'TASK_ADDED' | 'CLAIMED' | 'COMMITTED' | 'LEASE_EXPIRED' | 'PICKUP_GRANT' | 'TASK_TAKEN' | 'DELIVERED' | 'RELEASED' | 'ABORTED' | 'REORDERED';
  taskId: string;
  agent: string | null;
  data?: Record<string, unknown>;
}

export interface TaskStats {
  byState: Record<TaskState, number>;
  byPriority: Record<Priority, { total: number; delivered: number; onTime: number }>;
  total: number;
  delivered: number;
  onTime: number;
  late: number;
  /** Delivered tasks: mean / p95 lateness (s, 0 when on time). */
  meanLateness: number;
  p95Lateness: number;
  /** Open tasks already past their deadline. */
  overdueOpen: number;
  duplicatesResolved: number;
  /** Tasks whose drone was killed while carrying (re-ordered). */
  reordered: number;
}

/**
 * Shared order board. In this simulation it stands in for the depot nodes' replicated task state:
 * atomic claims, epoch-fenced leases with zombie-stop expiry (I3), CLAIMED → COMMITTED after
 * `t_commit`, depot pickup arbitration (`depot_pickup` in PRD section 10) and the point-of-no-return
 * rule (ownership becomes sticky after PICKED_UP). It never decides who takes what.
 */
export class TaskBoard implements TaskBoardView {
  readonly tasks: Task[] = [];
  private byId = new Map<string, Task>();
  /** Bumps when a priority-1 task is added — idle drones re-auction immediately (REQ-AUC-003). */
  urgentCounter = 0;
  /** Bumps on every state change (renderers / UI poll it). */
  version = 0;
  events: BoardEvent[] = [];
  private seqByDepot = new Map<string, number>();

  constructor(private cfg: { leaseTtlS: number; tCommitS: number }) {}

  private emit(e: BoardEvent): void {
    this.events.push(e);
    this.version++;
  }

  get(id: string): Task | undefined {
    return this.byId.get(id);
  }

  add(task: Task): Task {
    if (this.byId.has(task.task_id)) {
      // scripted ids can collide with generated ones: keep them unique and stable
      const n = (this.seqByDepot.get(task.task_id) ?? 0) + 1;
      this.seqByDepot.set(task.task_id, n);
      task.task_id = `${task.task_id}-${n}`;
    }
    this.tasks.push(task);
    this.byId.set(task.task_id, task);
    if (task.priority === 1) this.urgentCounter++;
    this.emit({ t: task.created_at, type: 'TASK_ADDED', taskId: task.task_id, agent: null, data: { priority: task.priority, drop: task.dropId, depot: task.origin_depot, scripted: task.scripted } });
    return task;
  }

  open(): readonly Task[] {
    return this.tasks.filter((t) => t.state === 'UNASSIGNED');
  }

  /** UNASSIGNED → CLAIMED with a fresh epoch and lease. One claim wins; later claims fail. */
  claim(taskId: string, droneId: string, bid: number, now: number): boolean {
    const t = this.byId.get(taskId);
    if (!t || t.state !== 'UNASSIGNED') return false;
    t.state = 'CLAIMED';
    t.owner = droneId;
    t.bid = bid;
    t.epoch += 1;
    t.lease_ttl = now + this.cfg.leaseTtlS;
    t.claimedAt = now;
    this.emit({ t: now, type: 'CLAIMED', taskId, agent: droneId, data: { epoch: t.epoch, bid } });
    return true;
  }

  /** Owner heartbeat renews its lease (pre-pickup only; post-pickup leases are sticky). */
  renew(taskId: string, droneId: string, now: number): void {
    const t = this.byId.get(taskId);
    if (!t || t.owner !== droneId) return;
    if (t.state === 'CLAIMED' || t.state === 'COMMITTED') t.lease_ttl = now + this.cfg.leaseTtlS;
  }

  /** Time-driven transitions: commit after T_commit; expire stale pre-pickup leases (zombie-stop, I3). */
  step(now: number): Task[] {
    const expired: Task[] = [];
    for (const t of this.tasks) {
      if (t.state === 'CLAIMED' && t.claimedAt !== undefined && now - t.claimedAt >= this.cfg.tCommitS) {
        t.state = 'COMMITTED';
        t.committedAt = now;
        this.emit({ t: now, type: 'COMMITTED', taskId: t.task_id, agent: t.owner, data: { epoch: t.epoch } });
      }
      if ((t.state === 'CLAIMED' || t.state === 'COMMITTED') && t.lease_ttl !== null && now > t.lease_ttl) {
        const old = t.owner;
        this.reopen(t, now);
        this.emit({ t: now, type: 'LEASE_EXPIRED', taskId: t.task_id, agent: old, data: { epoch: t.epoch } });
        expired.push(t);
      }
    }
    return expired;
  }

  private reopen(t: Task, now: number): void {
    t.state = 'UNASSIGNED';
    t.owner = null;
    t.bid = null;
    t.lease_ttl = null;
    t.epoch += 1;
    t.claimedAt = undefined;
    t.committedAt = undefined;
    void now;
  }

  /** Depot arbitration (PRD section 10 `depot_pickup`): only the highest valid epoch's owner gets the parcel. */
  pickup(taskId: string, droneId: string, epoch: number, now: number): 'PICKUP_GRANT' | 'TASK_TAKEN' {
    const t = this.byId.get(taskId);
    if (!t) return 'TASK_TAKEN';
    if (t.state === 'PICKED_UP' || t.state === 'DELIVERED' || t.state === 'ABORTED') {
      this.emit({ t: now, type: 'TASK_TAKEN', taskId, agent: droneId, data: { reason: `state ${t.state}` } });
      return 'TASK_TAKEN';
    }
    if (epoch < t.epoch || t.owner !== droneId) {
      this.emit({ t: now, type: 'TASK_TAKEN', taskId, agent: droneId, data: { reason: 'stale epoch or not owner', epoch, current: t.epoch, owner: t.owner } });
      return 'TASK_TAKEN';
    }
    t.state = 'PICKED_UP';
    t.pickedAt = now;
    t.lease_ttl = null; // point of no return: ownership is sticky
    this.emit({ t: now, type: 'PICKUP_GRANT', taskId, agent: droneId, data: { epoch: t.epoch } });
    return 'PICKUP_GRANT';
  }

  complete(taskId: string, droneId: string, time: number): void {
    const t = this.byId.get(taskId);
    if (!t || t.owner !== droneId || t.state !== 'PICKED_UP') return;
    t.state = 'DELIVERED';
    t.deliveredAt = time;
    this.emit({ t: time, type: 'DELIVERED', taskId, agent: droneId, data: { late: Math.max(0, time - t.deadline) } });
  }

  /** Owner gives a pre-pickup task back: it re-opens with a higher epoch (03 section 3.3). */
  release(taskId: string, droneId: string, now: number): void {
    const t = this.byId.get(taskId);
    if (!t || t.owner !== droneId || isTerminal(t)) return;
    if (t.state === 'PICKED_UP') {
      this.abortInFlight(taskId, now, 'returned to depot');
      return;
    }
    this.reopen(t, now);
    this.emit({ t: now, type: 'RELEASED', taskId, agent: droneId, data: { epoch: t.epoch } });
  }

  /**
   * In-flight parcel lost or returned (drone declared failed, or unreachable destination): the task is
   * ABORTED and a replacement parcel is ordered from the depot as a new task (assumption O4).
   */
  abortInFlight(taskId: string, now: number, reason: string): Task | null {
    const t = this.byId.get(taskId);
    if (!t || isTerminal(t)) return null;
    const owner = t.owner;
    t.state = 'ABORTED';
    t.abortedAt = now;
    t.lease_ttl = null;
    this.emit({ t: now, type: 'ABORTED', taskId, agent: owner, data: { reason } });
    const n = (this.seqByDepot.get(`re:${taskId}`) ?? 0) + 1;
    this.seqByDepot.set(`re:${taskId}`, n);
    const re: Task = {
      ...t,
      task_id: `${taskId}:r${n}`,
      state: 'UNASSIGNED',
      epoch: t.epoch + 1,
      owner: null,
      bid: null,
      lease_ttl: null,
      created_at: now,
      claimedAt: undefined,
      committedAt: undefined,
      pickedAt: undefined,
      deliveredAt: undefined,
      abortedAt: undefined,
      reorderOf: taskId,
    };
    this.tasks.push(re);
    this.byId.set(re.task_id, re);
    if (re.priority === 1) this.urgentCounter++;
    this.emit({ t: now, type: 'REORDERED', taskId: re.task_id, agent: null, data: { of: taskId } });
    return re;
  }

  /** Not yet delivered or aborted. */
  get pending(): number {
    return this.tasks.filter((t) => !isTerminal(t)).length;
  }

  get completed(): number {
    return this.tasks.filter((t) => t.state === 'DELIVERED').length;
  }

  stats(now: number): TaskStats {
    const byState: Record<TaskState, number> = { UNASSIGNED: 0, CLAIMED: 0, COMMITTED: 0, PICKED_UP: 0, DELIVERED: 0, ABORTED: 0 };
    const byPriority: TaskStats['byPriority'] = { 1: { total: 0, delivered: 0, onTime: 0 }, 2: { total: 0, delivered: 0, onTime: 0 }, 3: { total: 0, delivered: 0, onTime: 0 } };
    const lateness: number[] = [];
    let onTime = 0;
    let late = 0;
    let overdueOpen = 0;
    let reordered = 0;
    for (const t of this.tasks) {
      byState[t.state]++;
      if (t.reorderOf) reordered++;
      if (t.state === 'ABORTED') continue;
      byPriority[t.priority].total++;
      if (t.state === 'DELIVERED') {
        byPriority[t.priority].delivered++;
        const l = Math.max(0, (t.deliveredAt ?? now) - t.deadline);
        lateness.push(l);
        if (l <= 0) {
          onTime++;
          byPriority[t.priority].onTime++;
        } else late++;
      } else if (now > t.deadline) overdueOpen++;
    }
    lateness.sort((a, b) => a - b);
    const mean = lateness.length ? lateness.reduce((a, b) => a + b, 0) / lateness.length : 0;
    const p95 = lateness.length ? lateness[Math.min(lateness.length - 1, Math.floor(lateness.length * 0.95))] : 0;
    return {
      byState,
      byPriority,
      total: this.tasks.filter((t) => t.state !== 'ABORTED').length,
      delivered: byState.DELIVERED,
      onTime,
      late,
      meanLateness: mean,
      p95Lateness: p95,
      overdueOpen,
      duplicatesResolved: 0,
      reordered,
    };
  }
}
