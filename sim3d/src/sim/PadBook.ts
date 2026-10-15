import type { PadData, Vec3 } from '../world/types';

/**
 * Depot-arbitrated pad reservations (a stand-in for the replicated pad state of REQ-ENG-003, like the
 * TaskBoard is for tasks). A pad has at most one holder. A drone holds its pad while it sits on it and
 * releases it when it leaves on a task; a returning drone asks for its preferred pad first and otherwise
 * the nearest enabled free pad. Outages (`pad_outage`, `depot_outage`) disable pads for a window.
 *
 * Pure state: no randomness and no wall clock. With no outage and no foreign requests it grants every
 * drone its own pad, which is the behaviour before pad scarcity existed.
 */
export class PadBook {
  /** Bumped on every reservation or availability change. */
  version = 0;
  private readonly holders = new Map<string, string>();
  private readonly byDrone = new Map<string, string>();
  private readonly outages = new Map<string, number | undefined>();

  constructor(readonly pads: PadData[]) {}

  holderOf(padId: string): string | null {
    return this.holders.get(padId) ?? null;
  }

  padOf(droneId: string): string | null {
    return this.byDrone.get(droneId) ?? null;
  }

  private find(padId: string): PadData | undefined {
    return this.pads.find((p) => p.id === padId);
  }

  isEnabled(padId: string): boolean {
    return this.find(padId)?.enabled !== false;
  }

  /** Free for `droneId`: enabled and not held by someone else. */
  isFreeFor(padId: string, droneId: string): boolean {
    const h = this.holders.get(padId);
    return this.isEnabled(padId) && (h === undefined || h === droneId);
  }

  /** Reserves the pad for the drone (releasing its previous one). Returns false if it is taken or disabled. */
  reserve(padId: string, droneId: string): boolean {
    if (!this.isFreeFor(padId, droneId)) return false;
    const old = this.byDrone.get(droneId);
    if (old === padId) return true;
    if (old) this.holders.delete(old);
    this.holders.set(padId, droneId);
    this.byDrone.set(droneId, padId);
    this.version++;
    return true;
  }

  release(droneId: string): void {
    const old = this.byDrone.get(droneId);
    if (!old) return;
    this.holders.delete(old);
    this.byDrone.delete(droneId);
    this.version++;
  }

  /** The nearest pad (horizontal distance, then id) that is enabled and free for the drone, or null. */
  nearestFree(from: Vec3, droneId: string): PadData | null {
    let best: PadData | null = null;
    let bd = Infinity;
    for (const p of this.pads) {
      if (!this.isFreeFor(p.id, droneId)) continue;
      const d = Math.hypot(p.pos.x - from.x, p.pos.z - from.z);
      if (d < bd - 1e-9 || (Math.abs(d - bd) <= 1e-9 && best !== null && p.id < best.id)) {
        best = p;
        bd = d;
      }
    }
    return best;
  }

  /** Disables pads until `until` (sim seconds, open-ended if undefined). Returns the number of pads affected. */
  disable(padIds: string[], until?: number): number {
    let n = 0;
    for (const id of padIds) {
      const p = this.find(id);
      if (!p) continue;
      p.enabled = false;
      this.outages.set(id, until);
      n++;
    }
    if (n) this.version++;
    return n;
  }

  /** Re-enables pads whose outage window has elapsed. */
  step(now: number): void {
    let changed = false;
    for (const [id, until] of this.outages) {
      if (until !== undefined && now >= until) {
        const p = this.find(id);
        if (p) p.enabled = true;
        this.outages.delete(id);
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  /** Pads currently out of service. */
  get disabledIds(): string[] {
    return this.pads.filter((p) => p.enabled === false).map((p) => p.id);
  }

  /** Back to the initial state: every pad enabled and unreserved. */
  reset(): void {
    for (const p of this.pads) p.enabled = true;
    this.holders.clear();
    this.byDrone.clear();
    this.outages.clear();
    this.version++;
  }
}
