import type { PadData } from '../world/types';
import { LocalAgentController } from './LocalAgentController';
import type { Allocation } from './systems';
import type { AgentController, DroneBody, DronePhase } from './types';

/** Restrained, mutually distinguishable route/drone colours (no red: reserved for no-fly zones). */
export const DRONE_COLORS = [
  '#2563eb', // blue
  '#0d9488', // teal
  '#7c3aed', // violet
  '#db2777', // rose
  '#65a30d', // lime
  '#0891b2', // cyan
  '#4f46e5', // indigo
  '#a16207', // ochre
  '#c026d3', // fuchsia
  '#047857', // emerald
  '#0369a1', // sky
  '#6d28d9', // purple
  '#be185d', // magenta
  '#475569', // slate
];

export const FLYING_PHASES: readonly DronePhase[] = ['to_pickup', 'to_delivery', 'returning'];

/**
 * A drone in the world: physical body state (owned by the engine) plus a pluggable decision controller.
 * The controller never touches `body` directly — it returns velocity commands.
 */
export class DroneAgent {
  readonly body: DroneBody;
  trail: number[] = [];
  trailT = 0;
  avoidTrail: number[] = [];
  avoidSampleT = 0;
  avoidLastT = -Infinity;
  depleted = false;
  distance = 0;
  /** Battery drain multiplier (battery_drain fault). */
  drainFactor = 1;

  constructor(
    readonly id: string,
    readonly index: number,
    readonly color: string,
    readonly pad: PadData,
    readonly capacityKg: number,
    public controller: AgentController,
  ) {
    this.body = { pos: { x: pad.pos.x, y: pad.pos.y, z: pad.pos.z }, vel: { x: 0, y: 0, z: 0 }, heading: 0, battery: 100 };
  }

  get airborne(): boolean {
    return FLYING_PHASES.includes(this.controller.phase);
  }

  static create(id: string, index: number, color: string, pad: PadData, layerAlt: number, capacityKg: number, allocation: Allocation = 'auction'): DroneAgent {
    return new DroneAgent(id, index, color, pad, capacityKg, new LocalAgentController(id, pad.id, layerAlt, allocation));
  }
}
