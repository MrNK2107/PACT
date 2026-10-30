/**
 * `TaskBoardView` for one drone over its own `P2PNode` (docs/P2P_DESIGN.md section 1): the controller code is the
 * same as on the global board, but every answer comes from the drone's replica, its local clock and its partition
 * policy, and every write is a local replica write that gossip spreads.
 *
 * - `open()`: UNASSIGNED records the policy allows and whose origin depot is in contact (it must arbitrate the pickup
 *   and acknowledge the lease);
 * - `claim()`: local claim write after the radio auction, never over CLAIMED / COMMITTED (single-writer rule);
 * - `renew()`: no-op, the node commits and renews on its own cadence (`lease / 4`);
 * - `holds()`: false after a lease lapse (zombie-stop) or a lost merge (`duplicate_resolved`);
 * - `pickup()`: asynchronous, `'PENDING'` until the origin depot answers the PICKUP_REQ;
 * - `complete()` writes DELIVERED, `release()` the owner's release (or ABORTED for a parcel carried back).
 *
 * Task objects handed to the controller are stable per id and refreshed in place, like the global board's live
 * records, so a controller that keeps a reference sees the current epoch.
 */
import type { Task } from '../sim/Task';
import type { TaskBoardView } from '../sim/types';
import type { P2PNode } from './P2PNode';

export class ReplicaBoard implements TaskBoardView {
  private readonly objs = new Map<string, Task>();
  private openCache: { at: number; version: number; list: Task[] } | null = null;

  constructor(readonly node: P2PNode) {}

  get urgentCounter(): number {
    return this.node.urgentCount;
  }

  open(): readonly Task[] {
    const now = this.node.now;
    const version = this.node.replica.version;
    if (this.openCache && this.openCache.at === now && this.openCache.version === version) return this.openCache.list;
    const list: Task[] = [];
    for (const rec of this.node.replica.tasks()) {
      if (rec.state !== 'UNASSIGNED' || !this.node.claimable(rec)) continue;
      list.push(this.obj(rec.task_id)!);
    }
    this.openCache = { at: now, version, list };
    return list;
  }

  claim(taskId: string, droneId: string, bid: number, _now: number): boolean {
    if (droneId !== this.node.id) return false;
    const ok = this.node.claim(taskId, bid);
    if (ok) this.obj(taskId);
    return ok;
  }

  renew(_taskId: string, _droneId: string, _now: number): void {
    // the node renews on its own cadence (lease / 4) and only counts renewals its origin depot acknowledged
  }

  pickup(taskId: string, droneId: string, _epoch: number, _now: number): 'PICKUP_GRANT' | 'TASK_TAKEN' | 'PENDING' {
    if (droneId !== this.node.id) return 'TASK_TAKEN';
    const r = this.node.pickup(taskId);
    if (r !== 'PENDING') this.obj(taskId);
    return r;
  }

  complete(taskId: string, droneId: string, time: number): void {
    if (droneId !== this.node.id) return;
    const t = this.objs.get(taskId);
    this.node.complete(taskId, t ? time - t.deadline : 0);
    this.obj(taskId);
  }

  release(taskId: string, droneId: string, _now: number): void {
    if (droneId !== this.node.id) return;
    this.node.release(taskId);
    this.obj(taskId);
  }

  holds(taskId: string, droneId: string): boolean {
    return droneId === this.node.id && this.node.holds(taskId);
  }

  believedOpen(_heard: ReadonlySet<string>, _droneId: string): readonly Task[] {
    return this.open();
  }

  /** A peer my failure detector does not see ALIVE gets no new work from me (design section 7). */
  suspected(peer: string): boolean {
    return this.node.suspected(peer);
  }

  /** Stable controller object for a task, refreshed from the replica. */
  private obj(taskId: string): Task | undefined {
    const fresh = this.node.taskOf(taskId);
    if (!fresh) return this.objs.get(taskId);
    const cur = this.objs.get(taskId);
    if (!cur) {
      this.objs.set(taskId, fresh);
      return fresh;
    }
    Object.assign(cur, fresh);
    return cur;
  }
}
