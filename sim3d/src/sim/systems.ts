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
 *  - `cbba_plain`       decentralised; the same bid / claim / back-off auction over the radio (consensus among
 *                       neighbours only), but the board is unfenced: no atomic claim, no leases (so no expiry and no
 *                       zombie-stop) and no depot arbitration. A drone treats a task as free unless it can hear the
 *                       drone holding it, so claims made out of radio range lead to duplicate dispatches and
 *                       duplicate deliveries. Invariants I1 / I3 are expected to break for this system only.
 */
export type SystemId = 'pact' | 'central_full' | 'central_hub_loss' | 'greedy_nearest' | 'cbba_plain';

export const SYSTEM_IDS: readonly SystemId[] = ['pact', 'central_full', 'central_hub_loss', 'greedy_nearest', 'cbba_plain'];

export type Allocation = 'auction' | 'central' | 'greedy' | 'cbba';

/** Systems whose board keeps the ownership fencing (atomic claims, leases, depot arbitration). */
export function isFenced(system: SystemId): boolean {
  return system !== 'cbba_plain';
}

export function allocationOf(system: SystemId): Allocation {
  if (system === 'central_full' || system === 'central_hub_loss') return 'central';
  if (system === 'greedy_nearest') return 'greedy';
  if (system === 'cbba_plain') return 'cbba';
  return 'auction';
}

/** Services that `kill_service` can target. */
export const SERVICES = ['central_hub'] as const;
