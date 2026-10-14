import { radioEffectAt, type RadioEffect } from '../world/Radio';
import type { RadioZone, Vec3 } from '../world/types';

/**
 * Radio medium model owned by the engine. Dead zones shrink the range of any link with an endpoint
 * inside them and add packet loss; faults can switch zones on for a window (`radio_blackout`).
 * Pure and deterministic: no randomness and no knowledge of tasks, agents or safety logic. The
 * safety reflexes never read it (invariant I4: safety works with the network off).
 */
export class RadioModel {
  /** Bumped whenever a zone changes state (renderers re-draw on it). */
  version = 0;
  private readonly initial = new Map<string, boolean>();

  constructor(readonly zones: RadioZone[]) {
    for (const z of zones) this.initial.set(z.id, z.active);
  }

  get hasZones(): boolean {
    return this.zones.length > 0;
  }

  effectAt(p: Vec3): RadioEffect {
    return radioEffectAt(this.zones, p.x, p.y, p.z);
  }

  /** Effect on the link between two positions: the worse endpoint wins; losses combine. */
  link(a: Vec3, b: Vec3): RadioEffect {
    const ea = this.effectAt(a);
    const eb = this.effectAt(b);
    return {
      rangeFactor: Math.min(ea.rangeFactor, eb.rangeFactor),
      loss: ea.loss > 0 || eb.loss > 0 ? 1 - (1 - ea.loss) * (1 - eb.loss) : 0,
    };
  }

  /** Switches a zone on or off; `until` closes the window at that sim time. Returns false for an unknown id. */
  setActive(id: string, active: boolean, now = 0, until?: number): boolean {
    const z = this.zones.find((q) => q.id === id);
    if (!z) return false;
    z.active = active;
    z.closedFrom = active ? now : undefined;
    z.closedUntil = active ? until : undefined;
    this.version++;
    return true;
  }

  add(zone: RadioZone): void {
    this.zones.push(zone);
    this.version++;
  }

  /** Finds a zone by exact id, else the first whose id contains `id` (case-insensitive). */
  find(id: string): RadioZone | undefined {
    return this.zones.find((z) => z.id === id) ?? this.zones.find((z) => z.id.toLowerCase().includes(id.toLowerCase()));
  }

  /** Ends blackout windows that have elapsed. */
  step(now: number): void {
    let changed = false;
    for (const z of this.zones) {
      if (z.active && z.closedUntil !== undefined && now >= z.closedUntil) {
        z.active = this.initial.get(z.id) ?? false;
        z.closedFrom = undefined;
        z.closedUntil = undefined;
        changed = true;
      }
    }
    if (changed) this.version++;
  }

  /** Restores the initial state: fault-added zones are removed, windows cleared. */
  reset(): void {
    for (let i = this.zones.length - 1; i >= 0; i--) if (this.zones[i].source === 'fault') this.zones.splice(i, 1);
    for (const z of this.zones) {
      z.active = this.initial.get(z.id) ?? z.active;
      z.closedFrom = undefined;
      z.closedUntil = undefined;
    }
    this.version++;
  }
}
