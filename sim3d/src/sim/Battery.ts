import type { Scenario } from '../scenario/types';
import type { Vec3, WindField } from '../world/types';
import { windAt } from '../world/Wind';

/**
 * Energy model (REQ-ENG-001): electrical power with speed, payload and wind terms, integrated
 * against the scenario's battery capacity. The pessimistic estimator adds a sigma margin.
 *
 * NOT an aerodynamic model. `demoScale` accelerates drain so that charging is visible in a short
 * demo; it is applied identically to drain and to estimates, so planning decisions stay consistent.
 */
export interface EnergyModel {
  batteryWh: number;
  cruiseSpeed: number;
  /** Hotel load + hover baseline (W). */
  pBaseW: number;
  /** Drag term at cruise (W), scaled by (airspeed / cruise)^2. */
  pVelW: number;
  pPayloadWPerKg: number;
  hoverW: number;
  demoScale: number;
  /** Pessimistic margin on estimates. */
  sigma: number;
}

export function makeEnergyModel(s: Scenario): EnergyModel {
  return { batteryWh: s.fleet.battery_wh, cruiseSpeed: s.fleet.speed_mps, pBaseW: 60, pVelW: 170, pPayloadWPerKg: 60, hoverW: 240, demoScale: 3, sigma: 0.15 };
}

export function powerW(m: EnergyModel, airspeed: number, payloadKg: number, hovering: boolean): number {
  if (hovering) return m.hoverW + m.pPayloadWPerKg * payloadKg;
  const k = airspeed / m.cruiseSpeed;
  return m.pBaseW + m.pVelW * k * k + m.pPayloadWPerKg * payloadKg;
}

/** Airspeed from ground velocity and local wind (head-wind adds, tail-wind subtracts). */
export function airspeed(field: WindField, pos: Vec3, vel: Vec3): number {
  const gs = Math.hypot(vel.x, vel.z);
  if (gs < 0.2) return 0;
  const w = windAt(field, pos.x, pos.z);
  const ux = vel.x / gs;
  const uz = vel.z / gs;
  const head = -(w.vx * ux + w.vz * uz);
  return Math.max(0, gs + head);
}

/** Battery percentage consumed over `dt` seconds. */
export function drainPct(m: EnergyModel, field: WindField, pos: Vec3, vel: Vec3, payloadKg: number, dt: number, factor = 1): number {
  const gs = Math.hypot(vel.x, vel.z);
  const hovering = gs < 1 && Math.abs(vel.y) < 0.5;
  const p = powerW(m, airspeed(field, pos, vel), payloadKg, hovering);
  const wh = (p * dt) / 3600;
  return (wh / m.batteryWh) * 100 * m.demoScale * factor;
}

/**
 * Pessimistic energy (in battery %) for a sequence of straight legs flown at cruise speed, with wind
 * sampled every 100 m and `sigma` added on top.
 */
export function estimatePct(m: EnergyModel, field: WindField, legs: { from: Vec3; to: Vec3; payloadKg: number }[], extraHoverS = 0): number {
  let wh = 0;
  for (const l of legs) {
    const dx = l.to.x - l.from.x;
    const dz = l.to.z - l.from.z;
    const d = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(d / 100));
    const vx = (dx / (d || 1)) * m.cruiseSpeed;
    const vz = (dz / (d || 1)) * m.cruiseSpeed;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) / n;
      const pos = { x: l.from.x + dx * u, y: 30, z: l.from.z + dz * u };
      const seg = d / n;
      const t = seg / m.cruiseSpeed;
      wh += (powerW(m, airspeed(field, pos, { x: vx, y: 0, z: vz }), l.payloadKg, false) * t) / 3600;
    }
    // climb + descent at each end
    wh += (powerW(m, 0, l.payloadKg, true) * 14) / 3600;
  }
  wh += (powerW(m, 0, 0, true) * extraHoverS) / 3600;
  return (wh / m.batteryWh) * 100 * m.demoScale * (1 + m.sigma);
}

/**
 * Upper bound of the seconds a drone can stay aloft on `socPct` %: its energy over the minimum electrical draw of the
 * model (hotel load at zero airspeed, no payload; hovering and cruising both draw more). Physical evidence for the
 * failure detector (03 section 3.6): a silent drone cannot be declared failed by silence before this bound.
 */
export function enduranceBoundS(m: EnergyModel, socPct: number): number {
  const pctPerS = (m.pBaseW / 3600 / m.batteryWh) * 100 * m.demoScale;
  return Math.max(0, socPct) / pctPerS;
}
