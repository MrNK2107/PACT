import type { Rng } from '../world/rng';
import type { DropType, Vec3 } from '../world/types';

/**
 * Task record — field names follow docs/04_agent_first_PRD.md section 9.1 verbatim. Sim-side extras
 * (drop id, cluster type, timestamps) are added at the end and never gossiped.
 */
export type TaskState = 'UNASSIGNED' | 'CLAIMED' | 'COMMITTED' | 'PICKED_UP' | 'DELIVERED' | 'ABORTED';

/** State rank (03 section 3.3): terminal states are absorbing. */
export const STATE_RANK: Record<TaskState, number> = { UNASSIGNED: 0, CLAIMED: 1, COMMITTED: 2, PICKED_UP: 3, DELIVERED: 4, ABORTED: 4 };

export type Priority = 1 | 2 | 3;

export interface Task {
  task_id: string;
  origin_depot: string;
  pickup: Vec3;
  drop: Vec3;
  /** 1 urgent … 3 low. */
  priority: Priority;
  /** Sim seconds. */
  deadline: number;
  weight_kg: number;
  shard: string;
  state: TaskState;
  epoch: number;
  owner: string | null;
  bid: number | null;
  /** Absolute sim time at which the current lease expires (null when no lease). */
  lease_ttl: number | null;
  created_at: number;
  // ---- sim-side extras ---------------------------------------------------------------------------
  dropId: string;
  type: DropType;
  scripted: boolean;
  claimedAt?: number;
  committedAt?: number;
  pickedAt?: number;
  deliveredAt?: number;
  abortedAt?: number;
  /** For replacement parcels: the task this one re-orders (assumption O4). */
  reorderOf?: string;
}

/** `D1:00001234:ab12` — origin depot, HLC-style timestamp (ms, 8 digits), 4-hex nonce. */
export function makeTaskId(depotId: string, tSim: number, rng: Rng): string {
  const stamp = String(Math.round(tSim * 1000) % 1e8).padStart(8, '0');
  const nonce = Math.floor(rng.next() * 0xffff)
    .toString(16)
    .padStart(4, '0');
  return `${depotId}:${stamp}:${nonce}`;
}

export const TASK_ID_RE = /^D\d+:\d{8}:[0-9a-f]{4}$/;

export function isTerminal(t: Task): boolean {
  return t.state === 'DELIVERED' || t.state === 'ABORTED';
}

/**
 * Terms of the replacement for a parcel lost with a failed carrier (every system, so comparisons are fair; Decisions
 * 18, 19): a new urgent order, priority 1, with a fresh delivery window of the original length (at least 60 s) from
 * the moment it is re-ordered. A parcel its carrier gives back keeps its priority and deadline.
 */
export function urgentReplacementTerms(original: { deadline: number; created_at: number }, reorderedAt: number): { priority: Priority; deadline: number } {
  return { priority: 1, deadline: reorderedAt + Math.max(60, original.deadline - original.created_at) };
}
