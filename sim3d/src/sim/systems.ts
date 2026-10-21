/**
 * Systems under test (docs/05_evaluation_plan.md section 5.2, REQ-EVAL-001). A scenario picks one with
 * `system:` (default `pact`); the bench runner overrides it to compare systems on identical worlds, workloads
 * and fault scripts.
 *
 *  - `pact`             decentralised bid / claim / back-off over the radio, epoch-fenced leases (the default).
 *  - `central_full`     a central hub assigns idle drones to open tasks every `auction_period_s`, with global
 *                       knowledge and no radio limits; the hub never fails (upper bound).
 *  - `central_hub_loss` the same hub, but `kill_service(central_hub)` takes it down: drones finish the task they
 *                       hold, then hold / return to their pad (no new work).
 *  - `greedy_nearest`   decentralised; each idle drone claims the nearest feasible task straight away, without
 *                       priorities, deadlines or neighbour bids. The board's atomic claim still applies.
 *
 * `cbba_plain` (no leases / depot arbitration) is not implemented yet: removing the board's fencing would also
 * remove the I1 / I3 guarantees the scenario suite checks, so it needs its own invariant exemptions first.
 */
export type SystemId = 'pact' | 'central_full' | 'central_hub_loss' | 'greedy_nearest';

export const SYSTEM_IDS: readonly SystemId[] = ['pact', 'central_full', 'central_hub_loss', 'greedy_nearest'];

export type Allocation = 'auction' | 'central' | 'greedy';

export function allocationOf(system: SystemId): Allocation {
  if (system === 'central_full' || system === 'central_hub_loss') return 'central';
  if (system === 'greedy_nearest') return 'greedy';
  return 'auction';
}

/** Services that `kill_service` can target. */
export const SERVICES = ['central_hub'] as const;
