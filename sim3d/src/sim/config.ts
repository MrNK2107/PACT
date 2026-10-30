/**
 * Simulation constants. Motion is simplified kinematics (velocity-limited, acceleration-limited);
 * this is NOT an aerodynamic model. The battery model is a deliberately accelerated toy model so
 * charging behaviour is visible within a short demo.
 */
export const SIM: SimConfig = {
  /** Fixed physics/agent timestep (s). */
  dt: 0.05,
  maxStepsPerFrame: 12,

  // Drone kinematics
  cruiseSpeed: 11,
  maxVz: 5,
  maxAccel: 7,
  arriveRadius: 2.5,
  landRadius: 0.6,
  /** Visual-only scale applied to the drone model so it is legible at city scale. */
  droneVisualScale: 4,
  droneRadius: 1.5,
  hardCollisionDist: 3,

  // Communication & sensing
  commRange: 60,
  senseRange: 45,
  heartbeatPeriod: 0.1,
  neighborTimeout: 0.8,

  // Avoidance
  separation: 10,
  horizon: 6,
  obstacleRange: 6,
  noFlyRange: 8,

  // Battery (percent). Accelerated for demo purposes.
  drainFlying: 0.32,
  drainPayloadExtra: 0.1,
  drainHover: 0.35,
  chargeRate: 3,
  chargeTarget: 95,
  returnThreshold: 45,
  reserve: 28,

  // Tasks
  loadTime: 2.0,
  unloadTime: 2.0,
  /** Minimum claim window (s): how long a bidder listens for better CLAIMs before taking the task. */
  claimWindow: 0.5,
  /** Claim window in force: `claimWindow` stretched to cover the scenario's latency bound (see `claimWaitFor`). */
  claimWait: 0.55,
  orderInterval: 7,
  maxOpenOrders: 14,
  initialOrders: 5,

  layers: [28, 37, 46, 55],
  maxDrones: 50,

  // Bid score weights (03 section 3.4)
  w: { pri: 2.0, dist: 1.0, late: 1.5, energy: 1.0, pad: 0.5 },
  /** Endurance-bound stand-in for DECLARED_FAILED after a kill_drone fault (s). */
  tFailed: 60,
};

export interface SimConfig {
  dt: number;
  maxStepsPerFrame: number;
  cruiseSpeed: number;
  maxVz: number;
  maxAccel: number;
  arriveRadius: number;
  landRadius: number;
  droneVisualScale: number;
  droneRadius: number;
  hardCollisionDist: number;
  commRange: number;
  senseRange: number;
  heartbeatPeriod: number;
  neighborTimeout: number;
  separation: number;
  horizon: number;
  obstacleRange: number;
  noFlyRange: number;
  drainFlying: number;
  drainPayloadExtra: number;
  drainHover: number;
  chargeRate: number;
  chargeTarget: number;
  returnThreshold: number;
  reserve: number;
  loadTime: number;
  unloadTime: number;
  claimWindow: number;
  claimWait: number;
  orderInterval: number;
  maxOpenOrders: number;
  initialOrders: number;
  layers: number[];
  maxDrones: number;
  w: { pri: number; dist: number; late: number; energy: number; pad: number };
  tFailed: number;
}

/**
 * Effective claim window for a latency bound: at least `claimWindow`, and long enough (latency upper bound plus
 * one tick) that a bidder always hears a rival CLAIM sent before its own one reached that rival, so the later of two
 * concurrent bidders always learns of the earlier bid inside its window.
 */
export function claimWaitFor(latencyMs: readonly [number, number]): number {
  return Math.max(SIM.claimWindow, latencyMs[1] / 1000 + SIM.dt);
}

/** Scenario-driven parameters (NFR-6: scenario files are the only way to change behaviour). */
export function applyScenario(s: { fleet: { speed_mps: number; max_drones: number }; network: { range_m: number; latency_ms: [number, number] }; workload: { arrival_rate_per_min: number } }): void {
  SIM.cruiseSpeed = s.fleet.speed_mps;
  SIM.maxDrones = s.fleet.max_drones;
  SIM.commRange = s.network.range_m;
  SIM.claimWait = claimWaitFor(s.network.latency_ms);
  SIM.orderInterval = s.workload.arrival_rate_per_min > 0 ? 60 / s.workload.arrival_rate_per_min : Infinity;
}
