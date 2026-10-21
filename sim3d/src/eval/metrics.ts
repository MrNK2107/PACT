/**
 * Run metrics computed from the structured event log only (REQ-EVAL-003: replayable from `events.jsonl`).
 * Subset of docs/05_evaluation_plan.md section 5.4 that the current event stream supports.
 */

export interface LogEvent {
  t: number;
  agent: string | null;
  type: string;
  data: Record<string, unknown>;
}

export interface RunMetrics {
  /** Tasks that entered the board within the window. */
  released: number;
  /** Distinct tasks delivered within the window. */
  delivered: number;
  /** Delivered by their deadline. */
  onTime: number;
  /** On-time share of delivered tasks (%), null when nothing was delivered. */
  onTimePctOfDelivered: number | null;
  /**
   * On-time completion (%) of the tasks that fell due inside the window: delivered by the deadline / due.
   * The headline effectiveness number (AT-05 compares it across systems). Null when no task fell due.
   */
  onTimeRate: number | null;
  /** Tasks that fell due inside the window. */
  due: number;
  /** Mean lateness (s) over delivered tasks (0 when on time). */
  meanLatenessS: number;
  /** I1: deliveries of a task that was already delivered. */
  duplicateDeliveries: number;
  /** I3: pickups by a drone after it lost that task's lease (without re-claiming it). */
  zombiePickups: number;
  leaseExpiries: number;
  /** Depot refusals of a stale-epoch pickup (`TASK_TAKEN`). */
  depotRefusals: number;
  lossOfSeparation: number;
  batteryDepleted: number;
  /** Deliveries completed after the first fault fired (resilience: does work continue?). */
  deliveredAfterFirstFault: number;
}

export function computeMetrics(events: readonly LogEvent[], windowS: number): RunMetrics {
  const deadline = new Map<string, number>();
  const delivered = new Set<string>();
  const lost = new Set<string>();
  let onTime = 0;
  let late = 0;
  let duplicateDeliveries = 0;
  let zombiePickups = 0;
  let leaseExpiries = 0;
  let depotRefusals = 0;
  let lossOfSeparation = 0;
  let batteryDepleted = 0;
  let firstFault = Infinity;
  let deliveredAfterFirstFault = 0;
  const onTimeIds = new Set<string>();

  for (const e of events) {
    if (e.t > windowS + 1e-9) continue;
    const task = typeof e.data.task === 'string' ? e.data.task : null;
    switch (e.type) {
      case 'task_created':
        if (task && typeof e.data.deadline === 'number') deadline.set(task, e.data.deadline);
        break;
      case 'delivered':
        if (!task) break;
        if (delivered.has(task)) {
          duplicateDeliveries++;
          break;
        }
        delivered.add(task);
        if (e.t >= firstFault) deliveredAfterFirstFault++;
        {
          const d = deadline.get(task);
          if (d === undefined || e.t <= d + 1e-9) {
            onTime++;
            onTimeIds.add(task);
          } else late += e.t - d;
        }
        break;
      case 'zombie_stop':
        if (task) lost.add(`${e.agent}|${task}`);
        break;
      case 'claimed':
        if (task) lost.delete(`${e.agent}|${task}`);
        break;
      case 'picked_up':
        if (task && lost.has(`${e.agent}|${task}`)) zombiePickups++;
        break;
      case 'lease_expired':
        leaseExpiries++;
        break;
      case 'task_taken':
        depotRefusals++;
        break;
      case 'loss_of_separation':
        lossOfSeparation++;
        break;
      case 'battery_depleted':
        batteryDepleted++;
        break;
      default:
        if (e.type.startsWith('fault_') && !e.type.endsWith('_failed') && e.type !== 'fault_unsupported' && e.t < firstFault) firstFault = e.t;
    }
  }

  let due = 0;
  let dueOnTime = 0;
  for (const [id, d] of deadline) {
    if (d > windowS) continue;
    due++;
    if (onTimeIds.has(id)) dueOnTime++;
  }
  return {
    released: deadline.size,
    delivered: delivered.size,
    onTime,
    onTimePctOfDelivered: delivered.size ? round1((100 * onTime) / delivered.size) : null,
    onTimeRate: due ? round1((100 * dueOnTime) / due) : null,
    due,
    meanLatenessS: delivered.size ? round1(late / delivered.size) : 0,
    duplicateDeliveries,
    zombiePickups,
    leaseExpiries,
    depotRefusals,
    lossOfSeparation,
    batteryDepleted,
    deliveredAfterFirstFault,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
