import type { Vec3, WorldData } from '../world/types';
import type { ObstacleManager } from './ObstacleManager';
import type { PadBook } from './PadBook';
import type { NeighborInfo, PathPlanner, Waypoint } from './PathPlanner';

export type DronePhase = 'idle' | 'claiming' | 'to_pickup' | 'loading' | 'to_delivery' | 'unloading' | 'returning' | 'charging';

export type SiteStage = 'approach' | 'land' | 'work';

export type Message =
  | {
      type: 'HEARTBEAT';
      from: string;
      pos: Vec3;
      vel: Vec3;
      /** Intended (pre-avoidance) velocity — shared like ADS-B intent so neighbours can predict conflicts early. */
      intent: Vec3;
      priority: number;
      phase: DronePhase;
      /** Destination site while in the last leg of a route (used for pad-occupancy etiquette). */
      site: Vec3 | null;
      stage: SiteStage | null;
      t: number;
    }
  | { type: 'CLAIM'; from: string; taskId: string; cost: number; t: number };

export type { Task } from './Task';
import type { Task } from './Task';
import type { EnergyModel } from './Battery';

/**
 * What an agent may do to the shared order board (an environment service standing in for the depot
 * nodes' replicated state, not a coordinator). Claims are epoch-fenced; pickups are arbitrated.
 */
export interface TaskBoardView {
  /** Bumps when a priority-1 task arrives (event-driven re-auction, REQ-AUC-003). */
  readonly urgentCounter: number;
  open(): readonly Task[];
  claim(taskId: string, droneId: string, bid: number, now: number): boolean;
  renew(taskId: string, droneId: string, now: number): void;
  pickup(taskId: string, droneId: string, epoch: number, now: number): 'PICKUP_GRANT' | 'TASK_TAKEN';
  complete(taskId: string, droneId: string, time: number): void;
  release(taskId: string, droneId: string, now: number): void;
}

export interface AgentEvent {
  type: 'claimed' | 'picked_up' | 'delivered' | 'replanned' | 'plan_failed' | 'charging' | 'charged' | 'departed' | 'landed' | 'task_taken' | 'aborted' | 'zombie_stop' | 'pad_unavailable' | 'pad_changed';
  taskId?: string;
  detail?: string;
}

export interface DroneBody {
  pos: Vec3;
  vel: Vec3;
  heading: number;
  battery: number;
}

/** Everything an agent is allowed to perceive in one tick. No global fleet state. */
export interface Percept {
  time: number;
  dt: number;
  body: Readonly<DroneBody>;
  inbox: Message[];
  obstacles: ObstacleManager;
  planner: PathPlanner;
  tasks: TaskBoardView;
  /** A-priori static map knowledge (depots, drop points, pads, wind). */
  world: WorldData;
  /** Energy model shared by the fleet (battery capacity, power terms). */
  energy: EnergyModel;
  /** This drone's payload capacity (kg). */
  capacityKg: number;
  /** Policy knobs from the scenario. */
  socReserve: number;
  /** Depot-arbitrated pad reservations (absent: every drone keeps its own pad). */
  pads?: PadBook;
  /**
   * On-board sensing: drones within `senseRange`, with their observed position and velocity. Independent of the
   * radio (invariant I4: separation must work with the network off, e.g. inside a radio dead zone).
   */
  sensed?: { id: string; pos: Vec3; vel: Vec3 }[];
}

export interface Command {
  /** Desired velocity (m/s); the engine applies acceleration & speed limits. */
  velocity: Vec3;
  outbox: Message[];
  events: AgentEvent[];
  /** Agent asserts it is landed on a charger pad and wants to charge. */
  charging: boolean;
}

/** Read-only decision state exposed for telemetry & rendering. */
export interface BrainView {
  readonly id: string;
  readonly phase: DronePhase;
  readonly taskId: string | null;
  readonly carrying: boolean;
  readonly route: readonly Waypoint[];
  readonly routeIndex: number;
  readonly routeVersion: number;
  readonly cruiseAlt: number;
  readonly avoiding: boolean;
  readonly yielding: boolean;
  readonly conflictWith: readonly string[];
  readonly holdReason: string | null;
  readonly neighborCount: number;
  readonly neighbors: readonly NeighborInfo[];
  readonly priority: number;
  readonly delivered: number;
  readonly destination: Vec3 | null;
  readonly destinationLabel: string | null;
  readonly homePadId: string;
  /** The pad this drone currently uses (its preferred pad unless that was unavailable). */
  readonly padId: string;
}

/**
 * Pluggable decision logic. A controller sees only its own body state, messages that reached it
 * over the simulated radio, local sensing (obstacles) and the shared order board.
 * Swap `LocalAgentController` for a different implementation — or a bridge to ROS 2 — to change behaviour.
 */
export interface AgentController extends BrainView {
  update(p: Percept): Command;
}
