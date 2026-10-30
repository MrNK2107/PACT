import type { FaultDef } from '../scenario/types';
import type { DropType } from '../world/types';
import type { Priority } from './Task';

/** What the engine lets the injector do. Hooks that return false log `fault_<type>_failed` (e.g. an unknown id). */
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
  partition(def: Extract<FaultDef, { type: 'partition' }>, now: number): boolean;
  linkLoss(def: Extract<FaultDef, { type: 'link_loss' }>, now: number): boolean;
  clockDrift(def: Extract<FaultDef, { type: 'clock_drift' }>, now: number): boolean;
  backhaulCut(def: Extract<FaultDef, { type: 'backhaul_cut' }>, now: number): boolean;
  unsupported(def: FaultDef, now: number): void;
  log(type: string, data: Record<string, unknown>, now: number): void;
}

/**
 * Scripted fault injector (REQ-SIM-004). Faults fire once, in time order, from the simulation clock —
 * never from wall-clock. Supported here: urgent_job_burst, close_zone, radio_blackout, weather_front, storm_cell, altitude_cap, pad_outage, depot_outage, battery_drain, kill_drone, kill_service (only the central_hub_loss baseline has a service to lose), partition, link_loss, clock_drift, backhaul_cut (network model, src/net).
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
        case 'partition': {
          const ok = this.hooks.partition(def, now);
          this.hooks.log(ok ? 'fault_partition' : 'fault_partition_failed', { groups: def.groups, until: def.until }, now);
          break;
        }
        case 'link_loss': {
          const ok = this.hooks.linkLoss(def, now);
          this.hooks.log(ok ? 'fault_link_loss' : 'fault_link_loss_failed', { id: def.id, loss: def.loss ?? 1, dir: def.dir ?? 'both', until: def.until }, now);
          break;
        }
        case 'clock_drift': {
          const ok = this.hooks.clockDrift(def, now);
          this.hooks.log(ok ? 'fault_clock_drift' : 'fault_clock_drift_failed', { id: def.id, ppm: def.ppm }, now);
          break;
        }
        case 'backhaul_cut': {
          const ok = this.hooks.backhaulCut(def, now);
          this.hooks.log(ok ? 'fault_backhaul_cut' : 'fault_backhaul_cut_failed', { depots: def.depots ?? 'all', until: def.until }, now);
          break;
        }
        default: {
          // a type the schema does not know (scenario files are not checked against the union)
          const unknown = def as FaultDef;
          this.hooks.unsupported(unknown, now);
          this.hooks.log('fault_unsupported', { type: unknown.type }, now);
        }
      }
    }
  }

  get pending(): number {
    return this.faults.length - this.idx;
  }
}
