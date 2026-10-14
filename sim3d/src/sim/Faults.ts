import type { FaultDef } from '../scenario/types';
import type { DropType } from '../world/types';
import type { Priority } from './Task';

/** What the engine lets the injector do. Network faults need the (future) network model and are logged as unsupported. */
export interface FaultHooks {
  urgentBurst(n: number, priority: Priority, windowS: number, clusterType: DropType | undefined, now: number): void;
  closeZone(def: Extract<FaultDef, { type: 'close_zone' }>, now: number): boolean;
  radioBlackout(def: Extract<FaultDef, { type: 'radio_blackout' }>, now: number): boolean;
  batteryDrain(id: string, factor: number, now: number): void;
  killDrone(id: string, now: number): void;
  unsupported(def: FaultDef, now: number): void;
  log(type: string, data: Record<string, unknown>, now: number): void;
}

/**
 * Scripted fault injector (REQ-SIM-004). Faults fire once, in time order, from the simulation clock —
 * never from wall-clock. Supported here: urgent_job_burst, close_zone, radio_blackout, battery_drain, kill_drone.
 */
export class FaultInjector {
  private idx = 0;
  readonly fired: { t: number; def: FaultDef }[] = [];

  constructor(
    private faults: FaultDef[],
    private hooks: FaultHooks,
  ) {}

  step(now: number): void {
    while (this.idx < this.faults.length && this.faults[this.idx].t <= now) {
      const def = this.faults[this.idx++];
      this.fired.push({ t: now, def });
      switch (def.type) {
        case 'urgent_job_burst':
          this.hooks.urgentBurst(def.n ?? 10, def.priority ?? 1, def.window_s ?? 60, def.cluster_type, now);
          this.hooks.log('fault_urgent_job_burst', { n: def.n ?? 10, window_s: def.window_s ?? 60 }, now);
          break;
        case 'close_zone': {
          const ok = this.hooks.closeZone(def, now);
          this.hooks.log(ok ? 'fault_close_zone' : 'fault_close_zone_failed', { id: def.id, name: def.name, until: def.until }, now);
          break;
        }
        case 'radio_blackout': {
          const ok = this.hooks.radioBlackout(def, now);
          this.hooks.log(ok ? 'fault_radio_blackout' : 'fault_radio_blackout_failed', { id: def.id, name: def.name, until: def.until }, now);
          break;
        }
        case 'battery_drain':
          this.hooks.batteryDrain(def.id, def.factor, now);
          this.hooks.log('fault_battery_drain', { id: def.id, factor: def.factor }, now);
          break;
        case 'kill_drone':
          this.hooks.killDrone(def.id, now);
          this.hooks.log('fault_kill_drone', { id: def.id }, now);
          break;
        default:
          this.hooks.unsupported(def, now);
          this.hooks.log('fault_unsupported', { type: def.type }, now);
      }
    }
  }

  get pending(): number {
    return this.faults.length - this.idx;
  }
}
