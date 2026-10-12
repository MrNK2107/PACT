/**
 * Integration seam for ROS 2 / WebSocket / external simulators.
 *
 * STATUS: interface only. Nothing in the app connects to a network or a robot; `NullBridge` is the
 * only implementation. A real bridge would (a) serialise `BridgeState` frames from
 * `SimulationEngine.exportState()` to a topic / socket, and (b) swap a drone's decision logic with
 * `SimulationEngine.replaceController(id, controller)` where `controller` forwards `Percept`s to an
 * external process and returns its `Command`s.
 */
export interface BridgeDroneState {
  id: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  heading: number;
  battery: number;
  phase: string;
  taskId: string | null;
}

export interface BridgeState {
  time: number;
  drones: BridgeDroneState[];
}

export interface ExternalBridge {
  /** Minimum simulated seconds between `onState` calls. */
  readonly period: number;
  onState(state: BridgeState): void;
}

export class NullBridge implements ExternalBridge {
  readonly period = 1;
  onState(): void {
    /* intentionally empty — no external system is connected */
  }
}
