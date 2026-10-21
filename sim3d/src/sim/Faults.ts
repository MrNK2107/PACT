import type { FaultDef } from '../scenario/types';
import type { DropType } from '../world/types';
import type { Priority } from './Task';

/** What the engine lets the injector do. Network faults need the (future) network model and are logged as unsupported. */
export interface FaultHooks {
  urgentBurst(n: number, priority: Priority, windowS: number, clusterType: DropType | undefined, now: number): void;
  closeZone(def: Extract<FaultDef, { type: 'close_zone' }>, now: number): boolean;
  weatherFront(def: Extract<FaultDef, { type: 'weather_front' }>, now: number): boolean;
  stormCell(def: Extract<FaultDef, { type: 'storm_cell' }>, now: number): boolean;
  altitudeCap(def: Extract<FaultDef, { type: 'altitude_cap' }>, now: number): boolean;
  padOutage(target: { pad?: string; depot?: string }, now: number, until?: number): boolean;
  radioBlackout(def: Extract<FaultDef, { type: 'radio_blackout' }>, now: number): boolean;
  batteryDrain(id: string, factor: number, now: number): void;
  killDrone(id: string, now: number): void;
  killService(name: string, now: number): boolean;
  unsupported(def: FaultDef, now: number): void;
  log(type: string, data: Record<string, unknown>, now: number): void;
}

/**
 * Scripted fault injector (REQ-SIM-004). Faults fire once, in time order, from the simulation clock —
 * never from wall-clock. Supported here: urgent_job_burst, close_zone, radio_blackout, weather_front, storm_cell, altitude_cap, pad_outage, depot_outage, battery_drain, kill_drone, kill_service (only the central_hub_loss baseline has a service to lose).
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
        case 'weather_front': {
          const ok = this.hooks.weatherFront(def, now);
          this.hooks.log(ok ? 'fault_weather_front' : 'fault_weather_front_failed', { mean_mps: def.mean_mps, dir_deg: def.dir_deg, until: def.until }, now);
          break;
        }
        case 'storm_cell': {
          const ok = this.hooks.stormCell(def, now);
          this.hooks.log(ok ? 'fault_storm_cell' : 'fault_storm_cell_failed', { name: def.name, until: def.until }, now);
          break;
        }
        case 'altitude_cap': {
          const ok = this.hooks.altitudeCap(def, now);
          this.hooks.log(ok ? 'fault_altitude_cap' : 'fault_altitude_cap_failed', { cap_m: def.cap_m, until: def.until }, now);
          break;
        }
        case 'pad_outage':
        case 'depot_outage': {
          const ok = this.hooks.padOutage(def.type === 'pad_outage' ? { pad: def.id } : { depot: def.id }, now, def.until);
          this.hooks.log(ok ? `fault_${def.type}` : `fault_${def.type}_failed`, { id: def.id, until: def.until }, now);
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
        case 'kill_service': {
          const ok = this.hooks.killService(def.name, now);
          this.hooks.log(ok ? 'fault_kill_service' : 'fault_kill_service_failed', { name: def.name }, now);
          break;
        }
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
