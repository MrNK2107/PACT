import type { BridgeState, ExternalBridge } from '../integration/ExternalBridge';
import type { FaultDef, Scenario } from '../scenario/types';
import { pointInShape, polygonShape } from '../world/NoFly';
import { radioSpecsFrom, radioZoneFromSpec } from '../world/Radio';
import { shardOf } from '../world/Shards';
import { heightAt } from '../world/Terrain';
import { blendWindParams, boostWind, retargetWind, type WindBoost, type WindParams } from '../world/Wind';
import { LocalClock } from '../net/Clock';
import { Network, type WindowEnd } from '../net/Network';
import { P2P_DEFAULTS, type Envelope, type TaskKey, type TaskRecord } from '../p2p/contracts';
import { DepotNode } from '../p2p/DepotNode';
import { defaultP2PConfig, type NodeEvent, type P2PConfig } from '../p2p/node';
import { P2PNode } from '../p2p/P2PNode';
import { ReplicaBoard } from '../p2p/ReplicaBoard';
import { compareTaskKey, compareTaskRecord, isTerminalState, normTask, recordFromTask, taskFromRecord, taskKey, type Replica } from '../p2p/replica';
import { Rng } from '../world/rng';
import type { DropType, NoFlyShape, NoFlyZone, PadData, RadioZone, Vec3, WindField, WorldData } from '../world/types';
import { CentralHub, type HubDrone } from './CentralHub';
import { allocationOf, isFenced, SERVICES, type SystemId } from './systems';
import { drainPct, enduranceBoundS, makeEnergyModel, type EnergyModel } from './Battery';
import { applyScenario, SIM } from './config';
import { DRONE_COLORS, DroneAgent } from './DroneAgent';
import { FaultInjector } from './Faults';
import { ObstacleManager } from './ObstacleManager';
import { PathPlanner } from './PathPlanner';
import { PadBook } from './PadBook';
import { RadioModel } from './Radio';
import type { Priority, Task, TaskState } from './Task';
import { TaskBoard, type TaskStats } from './TaskBoard';
import type { AgentController, AgentEvent, DronePhase, Message } from './types';
import { WorkloadGenerator } from './WorkloadGenerator';

export type SimStatus = 'idle' | 'running' | 'paused';

/** Human-readable log line for the UI. */
export interface SimEvent {
  t: number;
  kind: 'info' | 'task' | 'avoid' | 'power' | 'warn' | 'fault';
  text: string;
}

/** Structured event (NFR-4): one per line in the exported log, hashed for the determinism test. */
export interface StructuredEvent {
  t: number;
  agent: string | null;
  type: string;
  data: Record<string, unknown>;
}

export interface RouteTrace {
  droneId: string;
  color: string;
  points: number[];
  t: number;
}

export interface DroneSummary {
  id: string;
  color: string;
  phase: DronePhase;
  battery: number;
  pos: Vec3;
  altitude: number;
  speed: number;
  heading: number;
  taskId: string | null;
  taskPriority: Priority | null;
  taskDeadline: number | null;
  taskState: TaskState | null;
  taskEpoch: number | null;
  payloadKg: number;
  pickup: string | null;
  delivery: string | null;
  carrying: boolean;
  neighbors: number;
  avoiding: boolean;
  conflictWith: string[];
  holdReason: string | null;
  delivered: number;
  routeProgress: [number, number];
  cruiseAlt: number;
  destination: string | null;
  homePad: string;
  /** The pad the drone currently uses. */
  pad: string;
  priority: number;
  distance: number;
  drainFactor: number;
}

const WIND_STEP_S = 10;

/** Envelope types the current controllers understand (their payload is a `Message`). */
const isControllerMessage = (e: Envelope): boolean => e.type === 'HEARTBEAT' || e.type === 'CLAIM';
/** Ledger changes younger than this (sim s) may still be in flight: `replica_converged` accepts the previous key. */
const CONVERGE_SETTLE_S = 3;

/**
 * Worst range factor of the static (map) radio zones touching the ball of radius `r` around `p` (1 if none). The
 * P2P nodes' a-priori radio knowledge (TC-09): an observer expects to hear a drone only where the map promises a link.
 */
function staticRadioFactor(zones: readonly RadioZone[], p: Vec3, r: number): number {
  let f = 1;
  for (const z of zones) {
    if (!z.active || p.y - r > z.maxY || z.rangeFactor >= f) continue;
    if (pointInShape(z.shape, p.x, p.z, r)) f = z.rangeFactor;
  }
  return f;
}
const STORM_STEP_S = 30;

export interface SimSnapshot {
  status: SimStatus;
  time: number;
  speed: number;
  fleet: number;
  airborne: number;
  charging: number;
  pending: number;
  open: number;
  completed: number;
  activeConflicts: number;
  totalConflicts: number;
  minSeparation: number | null;
  collisions: number;
  structureHits: number;
  terrainHits: number;
  drones: DroneSummary[];
  events: SimEvent[];
  canAddDrone: boolean;
  /** Open + in-progress orders referencing each drop point / depot id. */
  siteLoad: Record<string, number>;
  tasks: TaskStats;
  faultsPending: number;
  faultsFired: { t: number; type: string }[];
  /** Open tasks sorted by deadline (soonest first), for the task panel. */
  openTasks: { id: string; priority: Priority; deadline: number; state: TaskState; owner: string | null; drop: string; type: DropType; depot: string }[];
  closedZones: string[];
  /** Pads currently out of service. */
  padOutages: string[];
  /** Wind parameters in force (weather fronts change them). */
  wind: { mean: number; dirDeg: number; gust: number };
}

/**
 * Owns the simulation clock, fixed-timestep integration, the radio medium, the order board, the
 * workload generator, the fault injector and the physical state of every drone. It does NOT decide
 * what any drone does — each drone's controller does (see `AgentController`). Safe to drive from a
 * render loop, a worker, or a ROS 2/WebSocket bridge.
 */
export class SimulationEngine {
  readonly obstacles: ObstacleManager;
  readonly planner: PathPlanner;
  readonly radio: RadioModel;
  readonly pads: PadBook;
  /** Bumped whenever the wind field is rebuilt (weather fronts, storm cells). */
  windVersion = 0;
  private baseWind: WindField;
  private baseWindParams: Required<WindParams>;
  private windParams: Required<WindParams>;
  private windRamp: { from: Required<WindParams>; to: Required<WindParams>; t0: number; dur: number; lastStep: number } | null = null;
  private windRevert: { at: number; ramp: number } | null = null;
  private storms: { zoneId: string; r: number; from: { x: number; z: number }; to: { x: number; z: number }; t0: number; dur: number; end?: number; boost: WindBoost | null; lastStep: number }[] = [];
  readonly energy: EnergyModel;
  board: TaskBoard;
  workload: WorkloadGenerator;
  faults: FaultInjector;
  /** Simulated radio network (src/net): every drone and depot is a node. Rebuilt on reset. */
  net!: Network;
  agents: DroneAgent[] = [];
  status: SimStatus = 'idle';
  speed = 1;
  time = 0;

  completedRoutes: RouteTrace[] = [];
  avoidSegments: RouteTrace[] = [];
  log: SimEvent[] = [];
  events: StructuredEvent[] = [];

  // structural version counters (renderers poll these to rebuild imperative geometry)
  fleetVersion = 0;
  completedVersion = 0;
  avoidVersion = 0;
  resetEpoch = 0;

  activeConflicts = 0;
  totalConflicts = 0;
  minSeparation: number | null = null;
  collisions = 0;
  structureHits = 0;
  /** Airborne samples below the ground surface (never on flat maps: the floor clamp prevents it). */
  terrainHits = 0;

  /** Local (possibly drifting) clock per drone and depot; nothing but tests reads them yet. */
  private clocks = new Map<string, LocalClock>();
  private acc = 0;
  private droneSeq = 0;
  /**
   * Configured fleet roster (pact): every drone id launched, known to every node like any fleet configuration. The
   * QUORUM denominator is this roster minus the drones a node has DECLARED_FAILED (Decision 19). A fault-injected kill
   * leaves the roster unchanged (nobody is told); an operator removal is a reconfiguration and takes the drone out.
   */
  private roster: string[] = [];
  private conflicts = new Map<string, number>();
  private collisionPairs = new Set<string>();
  private listeners = new Set<() => void>();
  private bridges: { b: ExternalBridge; last: number }[] = [];
  private reorders: { taskId: string; at: number; drone: string }[] = [];
  private initialDrones: number;
  /** System under test (docs/05 section 5.2); `pact` unless the scenario or the bench runner picks a baseline. */
  readonly system: SystemId;
  /** Central hub of the `central_*` baselines (null for decentralised systems). */
  hub: CentralHub | null = null;
  /**
   * Under `pact` every drone and depot is a P2P node with its own replica (src/p2p); `board` is then a read-only
   * ledger: the CRDT merge of every node's writes, for the UI, stats and convergence checks. Agents never read it.
   */
  readonly p2p: boolean;
  private p2pCfg!: P2PConfig;
  private readonly staticRadioZones: RadioZone[];
  private droneNodes = new Map<string, P2PNode>();
  private replicaBoards = new Map<string, ReplicaBoard>();
  private depotNodes = new Map<string, DepotNode>();
  /** Ledger records (the merge of every write) and, per task, when the ledger key last changed and the key before. */
  private ledger = new Map<string, TaskRecord>();
  private ledgerMeta = new Map<string, { at: number; prev: TaskKey | null; terminalAt: number | null }>();
  private convergeWatch: { t0: number; warned: boolean } | null = null;

  constructor(
    readonly world: WorldData,
    readonly scenario: Scenario,
  ) {
    applyScenario(scenario);
    this.system = scenario.system ?? 'pact';
    this.p2p = this.system === 'pact';
    this.energy = makeEnergyModel(scenario);
    this.initialDrones = scenario.fleet.n_drones;
    this.obstacles = new ObstacleManager(world);
    this.planner = new PathPlanner(this.obstacles, world.bounds);
    this.radio = new RadioModel(world.radioZones);
    // a-priori radio knowledge of the P2P nodes: the map's own zones as built, never fault windows (TC-09 quorum votes)
    this.staticRadioZones = world.radioZones.filter((z) => z.source !== 'fault').map((z) => ({ ...z }));
    this.pads = new PadBook(world.pads);
    this.baseWind = world.wind;
    this.baseWindParams = { mean_mps: world.wind.mean, dir_deg: world.wind.dirDeg, gust_mps: world.wind.gust };
    this.windParams = { ...this.baseWindParams };
    this.board = new TaskBoard({ leaseTtlS: scenario.policy.lease_ttl_s, tCommitS: scenario.policy.t_commit_s, fenced: isFenced(scenario.system ?? 'pact') });
    this.workload = new WorkloadGenerator(world, scenario, new Rng(world.seed + 11));
    this.faults = new FaultInjector(scenario.faults, this.faultHooks());
    this.init();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------

  private init(): void {
    const s = this.scenario;
    this.board = new TaskBoard({ leaseTtlS: s.policy.lease_ttl_s, tCommitS: s.policy.t_commit_s, fenced: isFenced(this.system) });
    this.workload = new WorkloadGenerator(this.world, s, new Rng(this.world.seed + 11));
    this.faults = new FaultInjector(s.faults, this.faultHooks());
    this.agents = [];
    this.ledger = new Map();
    this.ledgerMeta = new Map();
    this.convergeWatch = null;
    this.initNetwork();
    this.time = 0;
    this.acc = 0;
    this.status = 'idle';
    this.completedRoutes = [];
    this.avoidSegments = [];
    this.log = [];
    this.events = [];
    this.reorders = [];
    this.activeConflicts = 0;
    this.totalConflicts = 0;
    this.minSeparation = null;
    this.collisions = 0;
    this.structureHits = 0;
    this.terrainHits = 0;
    this.conflicts.clear();
    this.collisionPairs.clear();
    this.droneSeq = 0;
    this.roster = [];
    this.hub = allocationOf(this.system) === 'central' ? new CentralHub(s.policy.auction_period_s) : null;
    // re-open every closable zone and clear fault-added zones
    for (const z of this.obstacles.allNoFly) if (z.closable && z.active) this.obstacles.setZoneActive(z.id, false);
    for (let i = this.obstacles.allNoFly.length - 1; i >= 0; i--) if (this.obstacles.allNoFly[i].source === 'fault') this.obstacles.allNoFly.splice(i, 1);
    this.obstacles.step(0);
    this.radio.reset();
    this.pads.reset();
    this.world.wind = this.baseWind;
    this.windParams = { ...this.baseWindParams };
    this.windRamp = null;
    this.windRevert = null;
    this.storms = [];
    this.windVersion++;
    for (let i = 0; i < this.initialDrones; i++) this.spawnDrone(false);
    // one drone per pad: a scenario asking for more drones than pads runs a smaller fleet (docs/DECISIONS.md, Decision 5)
    if (this.agents.length < this.initialDrones) {
      this.note('warn', `Fleet capped at ${this.agents.length} of ${this.initialDrones} drones: one drone per charging pad`, null, 'fleet_capped', { requested: this.initialDrones, spawned: this.agents.length, pads: this.world.pads.length });
    }
    // a few orders are waiting when the simulation starts (demo convenience; the Poisson stream takes over)
    for (let i = 0; i < SIM.initialOrders; i++) this.addTask(this.workload.makeTask(0, {}));
    this.fleetVersion++;
    this.completedVersion++;
    this.avoidVersion++;
    this.resetEpoch++;
    this.emit();
  }

  /**
   * Fresh network and clocks: depots become static nodes on a mast above the depot (they send nothing yet); drones
   * register as they spawn. The network draws from its own RNG stream (`seed ^ NET_RNG_SALT`), never the engine's.
   */
  private initNetwork(): void {
    const n = this.scenario.network;
    const bh = n.backhaul;
    this.net = new Network({ loss: n.loss, latencyMs: [n.latency_ms[0], n.latency_ms[1]], rangeM: n.range_m, seed: this.world.seed, backhaul: bh ? { enabled: bh.enabled, latencyMs: [bh.latency_ms[0], bh.latency_ms[1]], loss: bh.loss } : undefined }, this.radio);
    this.clocks = new Map();
    this.droneNodes = new Map();
    this.replicaBoards = new Map();
    this.depotNodes = new Map();
    const p = this.scenario.policy;
    this.p2pCfg = defaultP2PConfig({ leaseTtlS: p.lease_ttl_s, tCommitS: p.t_commit_s, policy: p.partition, gossipPeriodS: p.gossip_period_s });
    // TC-09 physical evidence: quorum votes only from observers that expected to hear the drone (nominal range x the
    // map's static radio zones, its position bounded by 1.5 x cruise speed since last located), and silence only past
    // the drone's endurance bound (full battery for a drone never heard from).
    const zones = this.staticRadioZones;
    const rangeM = n.range_m;
    this.p2pCfg.expect = {
      rangeM: (a, b, r) => rangeM * Math.min(staticRadioFactor(zones, a, 0), staticRadioFactor(zones, b, r)),
      maxSpeedMps: 1.5 * this.scenario.fleet.speed_mps,
      margin: 0.8,
    };
    this.p2pCfg.failure.opts = { ...this.p2pCfg.failure.opts, maxEnduranceS: enduranceBoundS(this.energy, 100) };
    const depotIds = this.world.depots.map((d) => d.id);
    for (const d of this.world.depots) {
      const mast = { x: d.pos.x, y: d.pos.y + P2P_DEFAULTS.depotMastM, z: d.pos.z };
      this.net.register(d.id, 'depot', () => mast);
      const clock = new LocalClock(() => this.time);
      this.clocks.set(d.id, clock);
      if (this.p2p) {
        this.depotNodes.set(
          d.id,
          new DepotNode({ id: d.id, clock, port: this.net.port(d.id), cfg: this.p2pCfg, pos: mast, catchmentShards: d.catchmentShards, depotIds, events: (e) => this.onNodeEvent(e), onWrite: (r) => this.ledgerMerge(r) }),
        );
      }
    }
  }

  /** P2P node of a drone (pact only). */
  nodeOf(id: string): P2PNode | undefined {
    return this.droneNodes.get(id);
  }

  /** P2P node of a depot (pact only). */
  depotNodeOf(id: string): DepotNode | undefined {
    return this.depotNodes.get(id);
  }

  /** Every live replica (depots first, then drones, in id order). Empty for the baselines. */
  replicas(): { id: string; replica: Replica }[] {
    const out: { id: string; replica: Replica }[] = [];
    for (const id of [...this.depotNodes.keys()].sort()) out.push({ id, replica: this.depotNodes.get(id)!.replica });
    for (const id of [...this.droneNodes.keys()].sort()) out.push({ id, replica: this.droneNodes.get(id)!.replica });
    return out;
  }

  /** Ledger record of a task (pact: the CRDT merge of every node's writes; undefined for the baselines). Read-only, for the viewer. */
  ledgerRecord(taskId: string): TaskRecord | undefined {
    return this.ledger.get(taskId);
  }

  /** The P2P configuration in force (pact). */
  get p2pConfig(): P2PConfig {
    return this.p2pCfg;
  }

  /** Local clock of a drone or depot (undefined for an unknown or removed id). */
  clockOf(id: string): LocalClock | undefined {
    return this.clocks.get(id);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.status === 'idle') {
      this.status = 'running';
      this.note('info', 'Simulation started', null, 'sim_started', { scenario: this.scenario.name, seed: this.world.seed });
      this.emit();
    }
  }
  pause(): void {
    if (this.status === 'running') {
      this.status = 'paused';
      this.emit();
    }
  }
  resume(): void {
    if (this.status === 'paused') {
      this.status = 'running';
      this.emit();
    }
  }
  reset(): void {
    applyScenario(this.scenario);
    this.init();
  }
  setSpeed(s: number): void {
    this.speed = s;
    this.emit();
  }

  /** Advance by `realDt` seconds of wall-clock time using a fixed-step accumulator. */
  update(realDt: number): void {
    if (this.status !== 'running') return;
    this.acc += Math.min(realDt, 0.1) * this.speed;
    let steps = 0;
    while (this.acc >= SIM.dt && steps < SIM.maxStepsPerFrame) {
      this.tick();
      this.acc -= SIM.dt;
      steps++;
    }
    if (steps >= SIM.maxStepsPerFrame) this.acc = 0;
  }

  /**
   * Replay (TC-13): run the fixed step until `time` reaches `t`, at most `maxTicks` steps, regardless of status and
   * wall clock. Returns true once `t` is reached. Because a run is a pure function of scenario + seed (AT-01), seeking
   * backwards is `reset()`, `start()`, then `advanceTo(t)`; the replay viewer slices it with `maxTicks`.
   */
  advanceTo(t: number, maxTicks = Number.POSITIVE_INFINITY): boolean {
    let n = 0;
    while (this.time + 1e-9 < t && n < maxTicks) {
      this.tick();
      n++;
    }
    this.acc = 0;
    if (n) this.emit();
    return this.time + 1e-9 >= t;
  }

  // ---- weather ---------------------------------------------------------------------------------------

  /** The wind field is rebuilt from the base field, the current parameters and the live storm boosts. */
  private rebuildWind(): void {
    const f = retargetWind(this.baseWind, this.windParams);
    this.world.wind = boostWind(f, this.storms.filter((s) => s.boost).map((s) => s.boost!));
    this.windVersion++;
  }

  private beginWindChange(to: Required<WindParams>, rampS: number, now: number): void {
    if (rampS > 0) {
      this.windRamp = { from: { ...this.windParams }, to, t0: now, dur: rampS, lastStep: now };
      return;
    }
    this.windRamp = null;
    this.windParams = to;
    this.rebuildWind();
  }

  /** Advances ramps, reverts and drifting storms. Everything is a function of sim time. */
  private stepWeather(now: number): void {
    let rebuild = false;
    if (this.windRevert && now >= this.windRevert.at) {
      const r = this.windRevert;
      this.windRevert = null;
      this.beginWindChange({ ...this.baseWindParams }, r.ramp, now);
    }
    const ramp = this.windRamp;
    if (ramp) {
      const t = Math.min(1, (now - ramp.t0) / ramp.dur);
      if (t >= 1 || now - ramp.lastStep >= WIND_STEP_S) {
        this.windParams = blendWindParams(ramp.from, ramp.to, t);
        ramp.lastStep = now;
        rebuild = true;
      }
      if (t >= 1) this.windRamp = null;
    }
    for (const s of this.storms) {
      if (s.end !== undefined && now >= s.end) {
        if (s.boost) rebuild = true;
        s.boost = null;
        continue;
      }
      if (s.dur > 0 && now - s.lastStep >= STORM_STEP_S) {
        const t = Math.min(1, (now - s.t0) / s.dur);
        const x = s.from.x + (s.to.x - s.from.x) * t;
        const z = s.from.z + (s.to.z - s.from.z) * t;
        this.obstacles.updateZoneShape(s.zoneId, { type: 'circle', x, z, r: s.r });
        if (s.boost) {
          s.boost.x = x;
          s.boost.z = z;
          rebuild = true;
        }
        s.lastStep = now;
      }
    }
    if (rebuild) this.rebuildWind();
  }

  /** Wind parameters in force (before storm boosts). */
  get windNow(): Required<WindParams> {
    return this.windParams;
  }

  // ---- fleet -----------------------------------------------------------------------------------------

  private freePad(): { pad: PadData } | null {
    // a pad is free for a new drone if no live drone was spawned on it, none holds it, and it is in service
    const used = new Set(this.agents.map((a) => a.pad.id));
    const free = (pid: string) => !used.has(pid) && this.pads.holderOf(pid) === null && this.pads.isEnabled(pid);
    const depots = this.world.depots;
    const start = this.agents.length % Math.max(1, depots.length);
    for (let k = 0; k < depots.length; k++) {
      const depot = depots[(start + k) % depots.length];
      for (const pid of depot.padIds) {
        if (free(pid)) return { pad: this.world.pads.find((p) => p.id === pid)! };
      }
    }
    // public pads outside the depots come last
    for (const p of this.world.pads) if (p.depotId === '' && free(p.id)) return { pad: p };
    return null;
  }

  private spawnDrone(announce = true): DroneAgent | null {
    if (this.agents.length >= SIM.maxDrones) return null;
    const fp = this.freePad();
    if (!fp) return null;
    const n = ++this.droneSeq;
    const id = `A${String(n).padStart(2, '0')}`;
    const idx = n - 1;
    const a = DroneAgent.create(id, idx, DRONE_COLORS[idx % DRONE_COLORS.length], fp.pad, SIM.layers[idx % SIM.layers.length], this.scenario.fleet.capacity_kg, allocationOf(this.system));
    this.agents.push(a);
    this.net.register(id, 'drone', () => a.body.pos);
    const clock = new LocalClock(() => this.time);
    this.clocks.set(id, clock);
    this.roster.push(id);
    if (this.p2p) {
      const node = new P2PNode({
        id,
        clock,
        port: this.net.port(id),
        cfg: this.p2pCfg,
        depots: this.world.depots.map((d) => ({ id: d.id, catchmentShards: d.catchmentShards })),
        homeDepot: fp.pad.depotId,
        roster: () => this.roster,
        events: (e) => this.onNodeEvent(e),
        onWrite: (r) => this.ledgerMerge(r),
      });
      this.droneNodes.set(id, node);
      this.replicaBoards.set(id, new ReplicaBoard(node));
    }
    this.pads.reserve(fp.pad.id, id);
    if (announce) this.note('info', `${id} added at ${fp.pad.id}`, id, 'drone_added', { pad: fp.pad.id });
    return a;
  }

  get canAddDrone(): boolean {
    return this.agents.length < SIM.maxDrones && this.freePad() !== null;
  }

  addDrone(): string | null {
    const a = this.spawnDrone(true);
    if (!a) return null;
    this.fleetVersion++;
    this.emit();
    return a.id;
  }

  removeDrone(id?: string, reason = 'removed'): string | null {
    if (!this.agents.length) return null;
    const a = id ? this.agents.find((x) => x.id === id) : this.agents[this.agents.length - 1];
    if (!a) return null;
    const tid = a.controller.taskId;
    const task = tid ? this.board.get(tid) : undefined;
    if (this.p2p) {
      // the drone just stops: its origin depot re-opens a pre-pickup lease on expiry, or aborts + re-orders a
      // carried parcel once the drone is declared failed (failure detector, design section 7)
      this.note('warn', `${a.id} ${reason}${task ? ` holding ${task.task_id} (${task.state})` : ''}`, a.id, task?.state === 'PICKED_UP' ? 'drone_lost_in_flight' : 'drone_removed', task ? { task: task.task_id } : {});
    } else if (task && task.state === 'PICKED_UP') {
      // in-flight parcel: re-ordered only once the drone is declared failed (endurance-bound stand-in)
      this.reorders.push({ taskId: task.task_id, at: this.time + SIM.tFailed, drone: a.id });
      this.note('warn', `${a.id} ${reason} with ${task.task_id} on board — replacement after ${SIM.tFailed} s unless it reappears`, a.id, 'drone_lost_in_flight', { task: task.task_id });
    } else if (task) {
      this.board.release(task.task_id, a.id, this.time);
      this.note('warn', `${a.id} ${reason} — ${task.task_id} returned to the order board`, a.id, 'drone_removed', { task: task.task_id });
    } else this.note('info', `${a.id} ${reason}`, a.id, 'drone_removed', {});
    this.agents = this.agents.filter((x) => x !== a);
    if (reason === 'removed') this.roster = this.roster.filter((x) => x !== a.id);
    this.pads.release(a.id);
    this.net.unregister(a.id);
    this.clocks.delete(a.id);
    this.droneNodes.delete(a.id);
    this.replicaBoards.delete(a.id);
    for (const k of [...this.conflicts.keys()]) if (k.split('|').includes(a.id)) this.conflicts.delete(k);
    this.fleetVersion++;
    this.emit();
    return a.id;
  }

  // ---- tasks / faults ----------------------------------------------------------------------------------

  private addTask(t: Task): void {
    const added = this.board.add(t);
    this.note('task', `${added.task_id} P${added.priority} ${added.origin_depot} → ${added.dropId}${added.scripted ? ' (scripted)' : ''}`, null, 'task_created', { task: added.task_id, priority: added.priority, deadline: added.deadline, weight_kg: added.weight_kg, shard: added.shard, scripted: added.scripted });
    if (this.p2p) {
      // intake: the origin depot writes the record into its replica and gossips it (the ledger already has it)
      const rec = recordFromTask(added);
      this.ledger.set(rec.task_id, rec);
      this.ledgerMeta.set(rec.task_id, { at: this.time, prev: null, terminalAt: null });
      this.depotNodes.get(added.origin_depot)?.intake(added);
    }
  }

  /** Ledger: merge one node write (CRDT join); the board mirrors the winner with sim-time stamps. */
  private ledgerMerge(rec: TaskRecord): void {
    const cur = this.ledger.get(rec.task_id);
    if (cur && compareTaskRecord(rec, cur) <= 0) return;
    const r = normTask(rec);
    this.ledger.set(r.task_id, r);
    if (!cur || compareTaskKey(taskKey(r), taskKey(cur)) !== 0) {
      const m = this.ledgerMeta.get(r.task_id);
      this.ledgerMeta.set(r.task_id, { at: this.time, prev: cur ? taskKey(cur) : null, terminalAt: isTerminalState(r.state) ? (m?.terminalAt ?? this.time) : null });
    }
    this.board.applyLedger(taskFromRecord(r, undefined), this.time);
  }

  /** Events reported by P2P nodes: stamped with sim time; some also go to the UI log. */
  private onNodeEvent(e: NodeEvent): void {
    if (e.text) this.note(e.kind ?? 'info', e.text, e.agent, e.type, e.data);
    else this.events.push({ t: this.time, agent: e.agent, type: e.type, data: e.data });
  }

  /**
   * AT-10 measurement: after a heal, the first tick at which every live replica holds the ledger's task keys. A
   * ledger change younger than `CONVERGE_SETTLE_S` may still be in flight (renewals never stop in a live run), so the
   * previous key is accepted for it; a terminal task a replica never saw is accepted once its tombstone would have
   * been pruned everywhere (it is no longer gossiped).
   */
  private checkConvergence(): void {
    const w = this.convergeWatch;
    if (!w) return;
    const reps = this.replicas();
    for (const [id, rec] of this.ledger) {
      const m = this.ledgerMeta.get(id);
      const want = taskKey(rec);
      const fresh = m !== undefined && this.time - m.at < CONVERGE_SETTLE_S;
      for (const { replica } of reps) {
        const r = replica.getTask(id);
        if (!r) {
          if (m && m.terminalAt !== null && this.time - m.terminalAt > P2P_DEFAULTS.tombstoneTtlS) continue;
          if (fresh && m!.prev === null) continue;
          return this.convergeTimeout(w);
        }
        const k = taskKey(r);
        if (compareTaskKey(k, want) === 0) continue;
        if (fresh && m!.prev && compareTaskKey(k, m!.prev) === 0) continue;
        return this.convergeTimeout(w);
      }
    }
    const elapsed = this.time - w.t0;
    this.convergeWatch = null;
    this.note('info', `Replicas converged ${elapsed.toFixed(1)} s after the heal (${reps.length} replicas, ${this.ledger.size} tasks)`, null, 'replica_converged', { elapsed_s: Math.round(elapsed * 1000) / 1000, replicas: reps.length, tasks: this.ledger.size });
  }

  private convergeTimeout(w: { t0: number; warned: boolean }): void {
    if (!w.warned && this.time - w.t0 > 6 * P2P_DEFAULTS.convergeS) {
      w.warned = true;
      this.note('warn', `Replicas not converged ${(this.time - w.t0).toFixed(0)} s after the heal`, null, 'replica_not_converged', { elapsed_s: Math.round((this.time - w.t0) * 1000) / 1000 });
    }
  }

  private faultHooks() {
    return {
      urgentBurst: (n: number, priority: Priority, windowS: number, clusterType: DropType | undefined, now: number) => {
        this.workload.burst(n, priority, windowS, now, clusterType);
        this.note('fault', `Fault: ${n} priority-${priority} jobs within ${windowS} s`, null, 'fault', { type: 'urgent_job_burst', n });
      },
      closeZone: (def: Extract<FaultDef, { type: 'close_zone' }>, now: number) => {
        let id = def.id;
        if (id && !this.obstacles.allNoFly.some((z) => z.id === id)) {
          // allow a loose reference such as "stadium" → the first closable zone whose id contains it
          const z = this.obstacles.allNoFly.find((q) => q.closable && q.id.toLowerCase().includes(id!.toLowerCase()));
          id = z?.id;
        }
        if (id) {
          const ok = this.obstacles.setZoneActive(id, true, now, def.until);
          if (ok) this.note('fault', `Fault: airspace ${id} closed${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'close_zone', id });
          return ok;
        }
        if (def.polygon || def.circle) {
          const zid = `NFZ-FAULT-${this.obstacles.allNoFly.filter((z) => z.source === 'fault').length + 1}`;
          const zone: NoFlyZone = {
            id: zid,
            name: def.name ?? 'Temporary closure',
            reason: 'Fault injection: close_zone',
            shape: def.polygon ? polygonShape(def.polygon.map((p) => ({ x: p.x, z: p.y }))) : { type: 'circle', x: def.circle!.x, z: def.circle!.y, r: def.circle!.r },
            maxY: 150,
            closable: true,
            active: true,
            closedFrom: now,
            closedUntil: def.until,
            source: 'fault',
          };
          this.obstacles.addZone(zone);
          this.world.noFlyZones.push(zone);
          this.note('fault', `Fault: ${zone.name} (${zid}) closed${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'close_zone', id: zid });
          return true;
        }
        return false;
      },
      weatherFront: (def: Extract<FaultDef, { type: 'weather_front' }>, now: number) => {
        const to = { mean_mps: def.mean_mps ?? this.windParams.mean_mps, dir_deg: def.dir_deg ?? this.windParams.dir_deg, gust_mps: def.gust_mps ?? this.windParams.gust_mps };
        this.beginWindChange(to, def.ramp_s ?? 0, now);
        this.windRevert = def.until !== undefined ? { at: def.until, ramp: def.ramp_s ?? 0 } : null;
        this.note('fault', `Weather front: wind ${to.mean_mps.toFixed(1)} m/s from ${to.dir_deg.toFixed(0)}°, gusts ${to.gust_mps.toFixed(1)}${def.ramp_s ? ` (ramp ${def.ramp_s} s)` : ''}${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'weather_front', ...to, t: now });
        return true;
      },
      stormCell: (def: Extract<FaultDef, { type: 'storm_cell' }>, now: number) => {
        const zid = `NFZ-STORM-${this.obstacles.allNoFly.filter((z) => z.id.startsWith('NFZ-STORM-')).length + 1}`;
        const shape: NoFlyShape = { type: 'circle', x: def.circle.x, z: def.circle.y, r: def.circle.r };
        const zone: NoFlyZone = {
          id: zid,
          name: def.name ?? 'Storm cell',
          reason: 'Weather: storm cell',
          shape,
          maxY: 400,
          minY: def.ceiling_m,
          closable: true,
          active: true,
          closedFrom: now,
          closedUntil: def.until,
          source: 'fault',
        };
        this.obstacles.addZone(zone);
        const boost: WindBoost | null = def.wind_mps && def.wind_mps > 0 ? { x: def.circle.x, z: def.circle.y, r: def.circle.r * 1.6, mps: def.wind_mps } : null;
        const dur = def.to ? (def.duration_s ?? 600) : 0;
        this.storms.push({ zoneId: zid, r: def.circle.r, from: { x: def.circle.x, z: def.circle.y }, to: def.to ? { x: def.to.x, z: def.to.y } : { x: def.circle.x, z: def.circle.y }, t0: now, dur, end: def.until, boost, lastStep: now });
        if (boost) this.rebuildWind();
        this.note('fault', `Storm cell ${zid} over (${def.circle.x.toFixed(0)}, ${def.circle.y.toFixed(0)})${def.ceiling_m ? ` above ${def.ceiling_m} m` : ''}${def.to ? ` drifting to (${def.to.x.toFixed(0)}, ${def.to.y.toFixed(0)})` : ''}${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'storm_cell', id: zid, t: now });
        return true;
      },
      altitudeCap: (def: Extract<FaultDef, { type: 'altitude_cap' }>, now: number) => {
        const b = this.world.bounds;
        let shape: NoFlyShape;
        if (def.polygon) shape = polygonShape(def.polygon.map((p) => ({ x: p.x, z: p.y })));
        else if (def.circle) shape = { type: 'circle', x: def.circle.x, z: def.circle.y, r: def.circle.r };
        else if (def.box) shape = { type: 'box', minX: Math.min(def.box.x0, def.box.x1), maxX: Math.max(def.box.x0, def.box.x1), minZ: Math.min(def.box.y0, def.box.y1), maxZ: Math.max(def.box.y0, def.box.y1) };
        else shape = { type: 'box', minX: b.minX, maxX: b.maxX, minZ: b.minZ, maxZ: b.maxZ };
        const zid = `NFZ-CAP-${this.obstacles.allNoFly.filter((z) => z.id.startsWith('NFZ-CAP-')).length + 1}`;
        this.obstacles.addZone({ id: zid, name: def.name ?? 'Altitude ceiling', reason: `Ceiling ${def.cap_m} m`, shape, maxY: 10000, minY: def.cap_m, closable: true, active: true, closedFrom: now, closedUntil: def.until, source: 'fault' });
        this.note('fault', `Altitude ceiling ${def.cap_m} m (${zid})${def.circle || def.box || def.polygon ? ' over an area' : ' everywhere'}${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'altitude_cap', id: zid, cap_m: def.cap_m, t: now });
        return true;
      },
      padOutage: (target: { pad?: string; depot?: string }, now: number, until?: number) => {
        const ids = target.pad ? [target.pad] : (this.world.depots.find((d) => d.id === target.depot)?.padIds ?? []);
        const n = this.pads.disable(ids, until);
        if (!n) return false;
        const what = target.pad ?? `depot ${target.depot}`;
        this.note('fault', `Fault: ${what} charging out of service${until !== undefined ? ` until ${until} s` : ''} (${n} pad${n > 1 ? 's' : ''})`, null, 'fault', { type: target.pad ? 'pad_outage' : 'depot_outage', target: what, t: now });
        return true;
      },
      radioBlackout: (def: Extract<FaultDef, { type: 'radio_blackout' }>, now: number) => {
        const existing = def.id ? this.radio.find(def.id) : undefined;
        if (existing) {
          if (def.range_factor !== undefined) existing.rangeFactor = def.range_factor;
          if (def.loss !== undefined) existing.lossAdd = def.loss;
          this.radio.setActive(existing.id, true, now, def.until);
          this.note('fault', `Fault: radio blackout in ${existing.id}${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'radio_blackout', id: existing.id });
          return true;
        }
        if (!(def.polygon || def.circle || def.box)) return false;
        const [spec] = radioSpecsFrom([{ name: def.name ?? 'Radio blackout', polygon: def.polygon, circle: def.circle, box: def.box, range_factor: def.range_factor, loss: def.loss, max_alt_m: def.max_alt_m }]);
        const zid = `RAD-FAULT-${this.radio.zones.filter((z) => z.source === 'fault').length + 1}`;
        const zone = radioZoneFromSpec({ ...spec, id: zid }, 0, 'fault');
        zone.closedFrom = now;
        zone.closedUntil = def.until;
        this.radio.add(zone);
        this.note('fault', `Fault: ${zone.name} (${zid}) radio dark${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'radio_blackout', id: zid });
        return true;
      },
      batteryDrain: (id: string, factor: number, now: number) => {
        for (const a of this.agents) if (id === 'all' || a.id === id) a.drainFactor = factor;
        this.note('fault', `Fault: battery drain ×${factor} on ${id}`, null, 'fault', { type: 'battery_drain', id, factor, t: now });
      },
      killDrone: (id: string, now: number) => {
        if (this.agents.some((a) => a.id === id)) {
          this.removeDrone(id, 'failed (fault injection)');
          this.note('fault', `Fault: ${id} killed`, id, 'fault', { type: 'kill_drone', id, t: now });
        } else this.note('warn', `Fault: kill_drone ${id} — no such drone`, null, 'fault_failed', { type: 'kill_drone', id });
      },
      killService: (name: string, now: number) => {
        if (!(SERVICES as readonly string[]).includes(name)) {
          this.note('warn', `Fault: kill_service ${name} — no such service`, null, 'fault_failed', { type: 'kill_service', name });
          return false;
        }
        // only the central_hub_loss baseline depends on the hub; PACT has no central service, central_full is the ideal
        const affected = this.system === 'central_hub_loss' && !!this.hub;
        if (affected) this.hub!.kill(now);
        this.note('fault', `Fault: ${name} killed${affected ? ' — no new dispatches' : ` (no effect on ${this.system})`}`, null, 'fault', { type: 'kill_service', name, affected, t: now });
        return true;
      },
      partition: (def: Extract<FaultDef, { type: 'partition' }>, now: number) => {
        const ok = this.net.partition(def.groups, def.until);
        if (ok) this.note('fault', `Fault: network partition ${def.groups.map((g) => `[${g.join(' ')}]`).join(' | ')}${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'partition', groups: def.groups, until: def.until, t: now });
        else this.note('warn', `Fault: partition with an unknown node in ${JSON.stringify(def.groups)}`, null, 'fault_failed', { type: 'partition', groups: def.groups });
        return ok;
      },
      linkLoss: (def: Extract<FaultDef, { type: 'link_loss' }>, now: number) => {
        const loss = def.loss ?? 1;
        const dir = def.dir ?? 'both';
        const ok = this.net.setLinkLoss(def.id, loss, dir, def.until);
        if (ok) this.note('fault', `Fault: ${def.id} link loss ${Math.round(loss * 100)}% (${dir})${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'link_loss', id: def.id, loss, dir, until: def.until, t: now });
        else this.note('warn', `Fault: link_loss ${def.id}: no such node`, null, 'fault_failed', { type: 'link_loss', id: def.id });
        return ok;
      },
      clockDrift: (def: Extract<FaultDef, { type: 'clock_drift' }>, now: number) => {
        const c = this.clocks.get(def.id);
        if (!c) {
          this.note('warn', `Fault: clock_drift ${def.id}: no such node`, null, 'fault_failed', { type: 'clock_drift', id: def.id });
          return false;
        }
        c.setDrift(def.ppm, now);
        this.note('fault', `Fault: ${def.id} clock drifts ${def.ppm} ppm`, null, 'fault', { type: 'clock_drift', id: def.id, ppm: def.ppm, t: now });
        return true;
      },
      backhaulCut: (def: Extract<FaultDef, { type: 'backhaul_cut' }>, now: number) => {
        const ids = this.net.cutBackhaul(def.depots, def.until);
        if (ids) this.note('fault', `Fault: depot backhaul cut (${ids.join(' ')})${def.until !== undefined ? ` until ${def.until} s` : ''}`, null, 'fault', { type: 'backhaul_cut', depots: ids, until: def.until, t: now });
        else this.note('warn', `Fault: backhaul_cut with an unknown depot in ${JSON.stringify(def.depots)}`, null, 'fault_failed', { type: 'backhaul_cut', depots: def.depots });
        return !!ids;
      },
      unsupported: (def: FaultDef, now: number) => {
        this.note('warn', `Fault ${def.type} at ${now.toFixed(0)} s is not supported`, null, 'fault_unsupported', { type: def.type });
      },
      log: (type: string, data: Record<string, unknown>, now: number) => {
        this.events.push({ t: now, agent: null, type, data });
      },
    };
  }

  // ---- tick ------------------------------------------------------------------------------------------

  private tick(): void {
    const dt = SIM.dt;
    this.obstacles.step(this.time);
    this.radio.step(this.time);
    for (const end of this.net.advance(this.time)) this.onNetWindowEnd(end);
    this.pads.step(this.time);
    this.stepWeather(this.time);
    this.obstacles.expireZones(this.time);
    this.faults.step(this.time);
    for (const t of this.workload.step(this.time)) this.addTask(t);
    if (!this.p2p) {
      for (const t of this.board.step(this.time)) this.note('warn', `${t.task_id} lease expired — re-opened at epoch ${t.epoch}`, null, 'lease_expired', { task: t.task_id, epoch: t.epoch });
      // replacement parcels for drones declared failed (endurance-bound stand-in; pact uses the failure detector)
      for (let i = this.reorders.length - 1; i >= 0; i--) {
        const r = this.reorders[i];
        if (this.time < r.at) continue;
        this.reorders.splice(i, 1);
        const re = this.board.abortInFlight(r.taskId, this.time, `${r.drone} declared failed`, true);
        if (re) this.note('task', `${r.drone} declared failed — ${r.taskId} re-ordered as ${re.task_id} (urgent)`, r.drone, 'task_reordered', { of: r.taskId, task: re.task_id, cause: 'declared_failed', peer: r.drone });
      }
    }
    if (this.hub?.due(this.time)) this.planCentral();
    this.net.deliver();
    // depots: P2P nodes under pact (intake, arbitration, re-opens, failure declaration); otherwise they only listen
    for (const d of this.world.depots) {
      const envs = this.net.take(d.id);
      const node = this.depotNodes.get(d.id);
      if (!node) continue;
      for (const e of envs) {
        if (e.type === 'HEARTBEAT') node.onBeacon(e.src, (e.payload as Extract<Message, { type: 'HEARTBEAT' }>).pos);
        else node.onEnvelope(e);
      }
      node.step();
    }

    for (const a of this.agents) {
      const node = this.droneNodes.get(a.id);
      const inbox = this.net.take(a.id, isControllerMessage);
      if (node) {
        for (const e of inbox) if (e.type === 'HEARTBEAT') node.onBeacon(e.src, (e.payload as Extract<Message, { type: 'HEARTBEAT' }>).pos);
        for (const e of this.net.take(a.id)) node.onEnvelope(e);
        const b = a.body;
        node.preStep({ pos: b.pos, battery: b.battery, enduranceS: enduranceBoundS(this.energy, b.battery), charging: a.controller.phase === 'charging', shard: shardOf(this.world.shards, b.pos.x, b.pos.z) });
      }
      const cmd = a.controller.update({
        time: this.time,
        dt,
        body: a.body,
        inbox: inbox.map((e) => e.payload as Message),
        obstacles: this.obstacles,
        planner: this.planner,
        tasks: this.replicaBoards.get(a.id) ?? this.board,
        world: this.world,
        energy: this.energy,
        capacityKg: a.capacityKg,
        socReserve: this.scenario.policy.soc_reserve,
        pads: this.pads,
        sensed: this.sense(a),
        hub: this.hub ?? undefined,
      });
      for (const m of cmd.outbox) this.net.send({ type: m.type, src: a.id, dst: '*', t_send: this.clocks.get(a.id)!.nowLocal(), payload: m });
      node?.step();
      for (const e of cmd.events) this.onAgentEvent(a, e);
      this.integrate(a, cmd.velocity, cmd.charging, dt);
      this.sampleTrails(a, dt);
    }

    // this tick's sends are resolved against end-of-tick positions and the link state in force now
    this.net.flush();
    this.checkConvergence();
    this.updateSafety();
    // board events become structured events (depot arbitration, leases, commits)
    if (this.board.events.length) {
      for (const e of this.board.events) this.events.push({ t: e.t, agent: e.agent, type: `board_${e.type.toLowerCase()}`, data: { task: e.taskId, ...(e.data ?? {}) } });
      this.board.events.length = 0;
    }
    this.time += dt;
    for (const br of this.bridges) {
      if (this.time - br.last >= br.b.period) {
        br.last = this.time;
        br.b.onState(this.exportState());
      }
    }
  }

  private onNetWindowEnd(end: WindowEnd): void {
    if (end.kind === 'partition') {
      this.note('fault', 'Network partition healed', null, 'partition_end', {});
      if (this.p2p) this.convergeWatch = { t0: this.time, warned: false };
    }
    else if (end.kind === 'backhaul_cut') {
      this.note('fault', `Depot backhaul restored (${end.depots.join(' ')})`, null, 'backhaul_restored', { depots: end.depots });
      if (this.p2p) this.convergeWatch = { t0: this.time, warned: false };
    } else this.note('fault', `${end.id} link loss ended`, null, 'link_loss_end', { id: end.id });
  }

  /** One central planning round: every idle drone (global knowledge, no radio) against every open task. */
  private planCentral(): void {
    const idle: HubDrone[] = [];
    for (const a of this.agents) {
      const c = a.controller;
      if (c.phase !== 'idle' || c.taskId || a.depleted) continue;
      const pad = this.world.pads.find((p) => p.id === c.padId) ?? a.pad;
      idle.push({
        id: a.id,
        ctx: { pos: a.body.pos, battery: a.body.battery, capacityKg: a.capacityKg, now: this.time, energy: this.energy, wind: this.world.wind, homePad: pad.pos, socReserve: this.scenario.policy.soc_reserve, obstacles: this.obstacles },
      });
    }
    const out = this.hub!.plan(this.time, idle, this.board.open());
    if (out.length) this.events.push({ t: this.time, agent: null, type: 'hub_dispatch', data: { n: out.length, idle: idle.length } });
  }

  private payloadOf(a: DroneAgent): number {
    if (!a.controller.carrying || !a.controller.taskId) return 0;
    return this.board.get(a.controller.taskId)?.weight_kg ?? 0;
  }

  private integrate(a: DroneAgent, v: Vec3, charging: boolean, dt: number): void {
    const b = a.body;
    const phase = a.controller.phase;
    const flying = a.airborne;

    if (b.battery <= 0) {
      if (!a.depleted) {
        a.depleted = true;
        this.note('warn', `${a.id} battery depleted — limp mode`, a.id, 'battery_depleted', {});
      }
      v = { x: v.x * 0.25, y: v.y * 0.25, z: v.z * 0.25 };
    }

    let dx = v.x - b.vel.x;
    let dy = v.y - b.vel.y;
    let dz = v.z - b.vel.z;
    const dl = Math.hypot(dx, dy, dz);
    const lim = SIM.maxAccel * dt;
    if (dl > lim) {
      const k = lim / dl;
      dx *= k;
      dy *= k;
      dz *= k;
    }
    b.vel.x += dx;
    b.vel.y += dy;
    b.vel.z += dz;
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.pos.z += b.vel.z * dt;
    // floor: the datum on flat maps; on hills a soft floor just under the ground, so a pad cell whose interpolated
    // ground is a little above the pad can never trap a landing drone
    const floorY = this.world.terrain.flat ? 0.05 : Math.max(0.05, heightAt(this.world.terrain, b.pos.x, b.pos.z) - 3);
    if (b.pos.y < floorY) {
      b.pos.y = floorY;
      if (b.vel.y < 0) b.vel.y = 0;
    }
    const bd = this.world.bounds;
    b.pos.x = Math.min(bd.maxX, Math.max(bd.minX, b.pos.x));
    b.pos.z = Math.min(bd.maxZ, Math.max(bd.minZ, b.pos.z));
    if (b.pos.y > bd.maxY) b.pos.y = bd.maxY;

    const hs = Math.hypot(b.vel.x, b.vel.z);
    if (hs > 0.8) {
      const target = Math.atan2(b.vel.x, b.vel.z);
      let d = target - b.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      b.heading += d * Math.min(1, 4 * dt);
    }
    a.distance += Math.hypot(b.vel.x, b.vel.y, b.vel.z) * dt;

    // Energy model (REQ-ENG-001): speed, payload and wind terms; accelerated for the demo.
    if (charging) {
      b.battery = Math.min(100, b.battery + SIM.chargeRate * dt);
      if (b.battery > 5) a.depleted = false;
    } else if (flying) {
      b.battery -= drainPct(this.energy, this.world.wind, b.pos, b.vel, this.payloadOf(a), dt, a.drainFactor);
    } else if (phase === 'claiming' || phase === 'idle' || phase === 'loading' || phase === 'unloading') {
      b.battery -= 0.03 * dt * a.drainFactor;
    }
    if (b.battery < 0) b.battery = 0;
  }

  /** Drones within sensing range of `a` (true state, no radio involved). */
  private sense(a: DroneAgent): { id: string; pos: Vec3; vel: Vec3 }[] {
    const out: { id: string; pos: Vec3; vel: Vec3 }[] = [];
    for (const b of this.agents) {
      if (b === a) continue;
      if (Math.hypot(a.body.pos.x - b.body.pos.x, a.body.pos.y - b.body.pos.y, a.body.pos.z - b.body.pos.z) <= SIM.senseRange) out.push({ id: b.id, pos: { ...b.body.pos }, vel: { ...b.body.vel } });
    }
    return out;
  }

  private onAgentEvent(a: DroneAgent, e: AgentEvent): void {
    switch (e.type) {
      case 'claimed':
        a.trail = [];
        this.note('task', `${a.id} claimed ${e.taskId} (${e.detail ?? ''})`, a.id, 'claimed', { task: e.taskId });
        break;
      case 'picked_up':
        this.note('task', `${a.id} picked up ${e.taskId}`, a.id, 'picked_up', { task: e.taskId });
        break;
      case 'task_taken':
        this.note('warn', `${a.id} refused at depot: ${e.taskId} already taken (stale epoch)`, a.id, 'task_taken', { task: e.taskId });
        break;
      case 'zombie_stop':
        this.note('warn', `${a.id} stopped acting on ${e.taskId} — lease lost (${e.detail ?? ''})`, a.id, 'zombie_stop', { task: e.taskId });
        break;
      case 'aborted':
        this.note('warn', `${a.id} aborted ${e.taskId}: ${e.detail ?? ''}`, a.id, 'aborted', { task: e.taskId, reason: e.detail });
        break;
      case 'delivered': {
        this.note('task', `${a.id} delivered ${e.taskId} (${e.detail ?? ''})`, a.id, 'delivered', { task: e.taskId, detail: e.detail });
        if (a.trail.length >= 6) {
          this.completedRoutes.push({ droneId: a.id, color: a.color, points: a.trail.slice(), t: this.time });
          if (this.completedRoutes.length > 14) this.completedRoutes.shift();
          this.completedVersion++;
        }
        a.trail = [];
        break;
      }
      case 'charging':
        this.note('power', `${a.id} charging at ${a.controller.padId} (${a.body.battery.toFixed(0)}%)`, a.id, 'charging', { pad: a.controller.padId, soc: Math.round(a.body.battery) });
        break;
      case 'charged':
        this.note('power', `${a.id} charged`, a.id, 'charged', {});
        break;
      case 'pad_unavailable':
        this.note('warn', `${a.id} waiting for a pad: ${e.detail ?? ''}`, a.id, 'pad_unavailable', { detail: e.detail });
        break;
      case 'pad_changed':
        this.note('power', `${a.id} switched pad: ${e.detail ?? ''}`, a.id, 'pad_changed', { detail: e.detail });
        break;
      case 'replanned':
        this.note('info', `${a.id} replanned route (${e.detail ?? ''})`, a.id, 'replanned', { detail: e.detail });
        break;
      case 'plan_failed':
        this.note('warn', `${a.id} could not plan a route to ${e.detail ?? ''}`, a.id, 'plan_failed', { detail: e.detail });
        break;
      default:
        this.events.push({ t: this.time, agent: a.id, type: e.type, data: { task: e.taskId, detail: e.detail } });
        break;
    }
  }

  private sampleTrails(a: DroneAgent, dt: number): void {
    const t = this.time;
    if (a.airborne && t - a.trailT >= 0.5) {
      a.trailT = t;
      a.trail.push(a.body.pos.x, a.body.pos.y, a.body.pos.z);
      if (a.trail.length > 1500) a.trail.splice(0, 3);
    }
    if (a.controller.avoiding) {
      a.avoidLastT = t;
      if (t - a.avoidSampleT >= 0.2) {
        a.avoidSampleT = t;
        a.avoidTrail.push(a.body.pos.x, a.body.pos.y, a.body.pos.z);
      }
    } else if (a.avoidTrail.length && t - a.avoidLastT > 0.5) {
      if (a.avoidTrail.length >= 9) {
        this.avoidSegments.push({ droneId: a.id, color: '#ea580c', points: a.avoidTrail.slice(), t });
        if (this.avoidSegments.length > 24) this.avoidSegments.shift();
        this.avoidVersion++;
      }
      a.avoidTrail = [];
    }
    void dt;
  }

  private updateSafety(): void {
    const t = this.time;
    const ids = new Set(this.agents.map((a) => a.id));
    const seen = new Set<string>();
    for (const a of this.agents) {
      for (const other of a.controller.conflictWith) {
        const key = ids.has(other) ? [a.id, other].sort().join('|') : `${a.id}|${other}`;
        seen.add(key);
        if (!this.conflicts.has(key)) {
          this.totalConflicts++;
          this.note('avoid', ids.has(other) ? `${a.id} ↔ ${other} conflict — ${a.controller.yielding ? a.id + ' yields' : 'priority holds course'}` : `${a.id} avoiding ${other}`, a.id, 'conflict', { with: other, yielding: a.controller.yielding });
        }
        this.conflicts.set(key, t);
      }
    }
    for (const [k, last] of this.conflicts) if (!seen.has(k) && t - last > 0.5) this.conflicts.delete(k);
    this.activeConflicts = [...this.conflicts.values()].filter((l) => t - l <= 0.5).length;

    for (let i = 0; i < this.agents.length; i++) {
      const A = this.agents[i];
      if (A.airborne && !this.world.terrain.flat && A.body.pos.y < this.obstacles.groundAt(A.body.pos.x, A.body.pos.z) - 0.5) {
        this.terrainHits++;
        this.note('warn', `${A.id} below the ground surface`, A.id, 'terrain_hit', {});
      }
      if (A.airborne) {
        const hit = this.obstacles.insideSolid(A.body.pos, 0.4, ['building']);
        const wp = A.controller.route[A.controller.routeIndex];
        if (hit && wp && wp.kind !== 'climb' && wp.kind !== 'land') {
          this.structureHits++;
          this.note('warn', `${A.id} entered structure ${hit.id}`, A.id, 'structure_hit', { obstacle: hit.id });
        }
      }
      for (let j = i + 1; j < this.agents.length; j++) {
        const B = this.agents[j];
        if (!A.airborne || !B.airborne) continue;
        const d = Math.hypot(A.body.pos.x - B.body.pos.x, A.body.pos.y - B.body.pos.y, A.body.pos.z - B.body.pos.z);
        if (this.minSeparation === null || d < this.minSeparation) this.minSeparation = d;
        const key = `${A.id}|${B.id}`;
        if (d < SIM.hardCollisionDist) {
          if (!this.collisionPairs.has(key)) {
            this.collisionPairs.add(key);
            this.collisions++;
            this.note('warn', `Loss of separation ${A.id}–${B.id} (${d.toFixed(1)} m)`, A.id, 'loss_of_separation', { with: B.id, d });
          }
        } else if (d > SIM.hardCollisionDist + 3) this.collisionPairs.delete(key);
      }
    }
  }

  private note(kind: SimEvent['kind'], text: string, agent: string | null = null, type: string = kind, data: Record<string, unknown> = {}): void {
    this.log.push({ t: this.time, kind, text });
    if (this.log.length > 80) this.log.shift();
    this.events.push({ t: this.time, agent, type, data });
  }

  // ---- integration points ----------------------------------------------------------------------------

  attachBridge(b: ExternalBridge): void {
    this.bridges.push({ b, last: -Infinity });
  }

  /** Swap one drone's decision logic (e.g. for an external / ROS 2-backed controller). */
  replaceController(id: string, controller: AgentController): boolean {
    const a = this.agents.find((x) => x.id === id);
    if (!a) return false;
    a.controller = controller;
    return true;
  }

  exportState(): BridgeState {
    return {
      mapId: this.scenario.map,
      scenario: this.scenario.name,
      seed: this.world.seed,
      bounds: { ...this.world.bounds },
      time: this.time,
      drones: this.agents.map((a) => ({
        id: a.id,
        position: { ...a.body.pos },
        velocity: { ...a.body.vel },
        heading: a.body.heading,
        battery: a.body.battery,
        phase: a.controller.phase,
        taskId: a.controller.taskId,
      })),
    };
  }

  /** Structured event log as JSONL (NFR-4). */
  exportEventsJsonl(): string {
    return this.events.map((e) => JSON.stringify({ t: Math.round(e.t * 1000) / 1000, agent: e.agent, type: e.type, data: e.data })).join('\n');
  }

  /** FNV-1a hash of the event log — equal across runs with the same scenario and seed (AT-01). */
  eventHash(): string {
    let h = 2166136261;
    const s = this.exportEventsJsonl();
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // ---- queries ---------------------------------------------------------------------------------------

  /** Pairs of agent indices with a usable link in at least one direction (range, partitions, link loss), for the overlay. */
  links(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < this.agents.length; i++) {
      for (let j = i + 1; j < this.agents.length; j++) {
        const a = this.agents[i].id;
        const b = this.agents[j].id;
        if (this.net.linkUp(a, b) || this.net.linkUp(b, a)) out.push([i, j]);
      }
    }
    return out;
  }

  snapshot(): SimSnapshot {
    const drones: DroneSummary[] = this.agents.map((a) => {
      const c = a.controller;
      const task = c.taskId ? this.board.get(c.taskId) : undefined;
      return {
        id: a.id,
        color: a.color,
        phase: c.phase,
        battery: a.body.battery,
        pos: { ...a.body.pos },
        altitude: a.body.pos.y,
        speed: Math.hypot(a.body.vel.x, a.body.vel.y, a.body.vel.z),
        heading: ((a.body.heading * 180) / Math.PI + 360) % 360,
        taskId: c.taskId,
        taskPriority: task?.priority ?? null,
        taskDeadline: task?.deadline ?? null,
        taskState: task?.state ?? null,
        taskEpoch: task?.epoch ?? null,
        payloadKg: this.payloadOf(a),
        pickup: task?.origin_depot ?? null,
        delivery: task?.dropId ?? null,
        carrying: c.carrying,
        neighbors: c.neighborCount,
        avoiding: c.avoiding,
        conflictWith: [...c.conflictWith],
        holdReason: c.holdReason,
        delivered: c.delivered,
        routeProgress: [Math.min(c.routeIndex, c.route.length), c.route.length],
        cruiseAlt: c.cruiseAlt,
        destination: c.destinationLabel,
        homePad: c.homePadId,
        pad: c.padId,
        priority: c.priority,
        distance: a.distance,
        drainFactor: a.drainFactor,
      };
    });
    const siteLoad: Record<string, number> = {};
    const openTasks: SimSnapshot['openTasks'] = [];
    for (const t of this.board.tasks) {
      if (t.state === 'DELIVERED' || t.state === 'ABORTED') continue;
      siteLoad[t.origin_depot] = (siteLoad[t.origin_depot] ?? 0) + 1;
      siteLoad[t.dropId] = (siteLoad[t.dropId] ?? 0) + 1;
      openTasks.push({ id: t.task_id, priority: t.priority, deadline: t.deadline, state: t.state, owner: t.owner, drop: t.dropId, type: t.type, depot: t.origin_depot });
    }
    openTasks.sort((a, b) => a.deadline - b.deadline);
    return {
      status: this.status,
      time: this.time,
      speed: this.speed,
      fleet: this.agents.length,
      airborne: this.agents.filter((a) => a.airborne).length,
      charging: this.agents.filter((a) => a.controller.phase === 'charging').length,
      pending: this.board.pending,
      open: this.board.open().length,
      completed: this.board.completed,
      activeConflicts: this.activeConflicts,
      totalConflicts: this.totalConflicts,
      minSeparation: this.minSeparation,
      collisions: this.collisions,
      structureHits: this.structureHits,
      terrainHits: this.terrainHits,
      drones,
      events: this.log.slice(-14).reverse(),
      canAddDrone: this.canAddDrone,
      siteLoad,
      tasks: this.board.stats(this.time),
      faultsPending: this.faults.pending,
      faultsFired: this.faults.fired.map((f) => ({ t: f.t, type: f.def.type })),
      openTasks: openTasks.slice(0, 40),
      padOutages: this.pads.disabledIds,
      wind: { mean: this.windParams.mean_mps, dirDeg: this.windParams.dir_deg, gust: this.windParams.gust_mps },
      closedZones: this.obstacles.allNoFly.filter((z) => z.active && (z.source === 'fault' || z.closedFrom !== undefined)).map((z) => z.id),
    };
  }
}
