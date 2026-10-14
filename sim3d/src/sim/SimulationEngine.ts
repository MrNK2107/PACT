import type { BridgeState, ExternalBridge } from '../integration/ExternalBridge';
import type { FaultDef, Scenario } from '../scenario/types';
import { polygonShape } from '../world/NoFly';
import { radioSpecsFrom, radioZoneFromSpec } from '../world/Radio';
import { Rng } from '../world/rng';
import type { DropType, NoFlyZone, PadData, Vec3, WorldData } from '../world/types';
import { MessageBus } from './AgentCoordinator';
import { drainPct, makeEnergyModel, type EnergyModel } from './Battery';
import { applyScenario, SIM } from './config';
import { DRONE_COLORS, DroneAgent } from './DroneAgent';
import { FaultInjector } from './Faults';
import { ObstacleManager } from './ObstacleManager';
import { PathPlanner } from './PathPlanner';
import { RadioModel } from './Radio';
import type { Priority, Task, TaskState } from './Task';
import { TaskBoard, type TaskStats } from './TaskBoard';
import type { AgentController, AgentEvent, DronePhase } from './types';
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
  priority: number;
  distance: number;
  drainFactor: number;
}

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
  readonly energy: EnergyModel;
  board: TaskBoard;
  workload: WorkloadGenerator;
  faults: FaultInjector;
  bus = new MessageBus();
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

  private rng: Rng;
  private acc = 0;
  private droneSeq = 0;
  private conflicts = new Map<string, number>();
  private collisionPairs = new Set<string>();
  private listeners = new Set<() => void>();
  private bridges: { b: ExternalBridge; last: number }[] = [];
  private reorders: { taskId: string; at: number; drone: string }[] = [];
  private initialDrones: number;

  constructor(
    readonly world: WorldData,
    readonly scenario: Scenario,
  ) {
    applyScenario(scenario);
    this.energy = makeEnergyModel(scenario);
    this.initialDrones = scenario.fleet.n_drones;
    this.obstacles = new ObstacleManager(world);
    this.planner = new PathPlanner(this.obstacles, world.bounds);
    this.radio = new RadioModel(world.radioZones);
    this.rng = new Rng(world.seed + 7);
    this.board = new TaskBoard({ leaseTtlS: scenario.policy.lease_ttl_s, tCommitS: scenario.policy.t_commit_s });
    this.workload = new WorkloadGenerator(world, scenario, new Rng(world.seed + 11));
    this.faults = new FaultInjector(scenario.faults, this.faultHooks());
    this.init();
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------

  private init(): void {
    const s = this.scenario;
    this.board = new TaskBoard({ leaseTtlS: s.policy.lease_ttl_s, tCommitS: s.policy.t_commit_s });
    this.workload = new WorkloadGenerator(this.world, s, new Rng(this.world.seed + 11));
    this.faults = new FaultInjector(s.faults, this.faultHooks());
    this.bus = new MessageBus();
    this.agents = [];
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
    this.conflicts.clear();
    this.collisionPairs.clear();
    this.droneSeq = 0;
    this.rng = new Rng(this.world.seed + 7);
    // re-open every closable zone and clear fault-added zones
    for (const z of this.obstacles.allNoFly) if (z.closable && z.active) this.obstacles.setZoneActive(z.id, false);
    for (let i = this.obstacles.allNoFly.length - 1; i >= 0; i--) if (this.obstacles.allNoFly[i].source === 'fault') this.obstacles.allNoFly.splice(i, 1);
    this.obstacles.step(0);
    this.radio.reset();
    for (let i = 0; i < this.initialDrones; i++) this.spawnDrone(false);
    // a few orders are waiting when the simulation starts (demo convenience; the Poisson stream takes over)
    for (let i = 0; i < SIM.initialOrders; i++) this.addTask(this.workload.makeTask(0, {}));
    this.fleetVersion++;
    this.completedVersion++;
    this.avoidVersion++;
    this.resetEpoch++;
    this.emit();
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

  // ---- fleet -----------------------------------------------------------------------------------------

  private freePad(): { pad: PadData } | null {
    const used = new Set(this.agents.map((a) => a.pad.id));
    const depots = this.world.depots;
    const start = this.agents.length % Math.max(1, depots.length);
    for (let k = 0; k < depots.length; k++) {
      const depot = depots[(start + k) % depots.length];
      for (const pid of depot.padIds) {
        if (!used.has(pid)) return { pad: this.world.pads.find((p) => p.id === pid)! };
      }
    }
    return null;
  }

  private spawnDrone(announce = true): DroneAgent | null {
    if (this.agents.length >= SIM.maxDrones) return null;
    const fp = this.freePad();
    if (!fp) return null;
    const n = ++this.droneSeq;
    const id = `A${String(n).padStart(2, '0')}`;
    const idx = n - 1;
    const a = DroneAgent.create(id, idx, DRONE_COLORS[idx % DRONE_COLORS.length], fp.pad, SIM.layers[idx % SIM.layers.length], this.scenario.fleet.capacity_kg);
    this.agents.push(a);
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
    if (task && task.state === 'PICKED_UP') {
      // in-flight parcel: re-ordered only once the drone is declared failed (endurance-bound stand-in)
      this.reorders.push({ taskId: task.task_id, at: this.time + SIM.tFailed, drone: a.id });
      this.note('warn', `${a.id} ${reason} with ${task.task_id} on board — replacement after ${SIM.tFailed} s unless it reappears`, a.id, 'drone_lost_in_flight', { task: task.task_id });
    } else if (task) {
      this.board.release(task.task_id, a.id, this.time);
      this.note('warn', `${a.id} ${reason} — ${task.task_id} returned to the order board`, a.id, 'drone_removed', { task: task.task_id });
    } else this.note('info', `${a.id} ${reason}`, a.id, 'drone_removed', {});
    this.agents = this.agents.filter((x) => x !== a);
    this.bus.drop(a.id);
    for (const k of [...this.conflicts.keys()]) if (k.split('|').includes(a.id)) this.conflicts.delete(k);
    this.fleetVersion++;
    this.emit();
    return a.id;
  }

  // ---- tasks / faults ----------------------------------------------------------------------------------

  private addTask(t: Task): void {
    const added = this.board.add(t);
    this.note('task', `${added.task_id} P${added.priority} ${added.origin_depot} → ${added.dropId}${added.scripted ? ' (scripted)' : ''}`, null, 'task_created', { task: added.task_id, priority: added.priority, deadline: added.deadline, weight_kg: added.weight_kg, shard: added.shard, scripted: added.scripted });
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
      unsupported: (def: FaultDef, now: number) => {
        this.note('warn', `Fault ${def.type} at ${now.toFixed(0)} s is not supported yet (needs the network model)`, null, 'fault_unsupported', { type: def.type });
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
    this.obstacles.expireZones(this.time);
    this.faults.step(this.time);
    for (const t of this.workload.step(this.time)) this.addTask(t);
    for (const t of this.board.step(this.time)) this.note('warn', `${t.task_id} lease expired — re-opened at epoch ${t.epoch}`, null, 'lease_expired', { task: t.task_id, epoch: t.epoch });
    // replacement parcels for drones declared failed
    for (let i = this.reorders.length - 1; i >= 0; i--) {
      const r = this.reorders[i];
      if (this.time < r.at) continue;
      this.reorders.splice(i, 1);
      const re = this.board.abortInFlight(r.taskId, this.time, `${r.drone} declared failed`);
      if (re) this.note('task', `${r.drone} declared failed — ${r.taskId} re-ordered as ${re.task_id}`, r.drone, 'task_reordered', { of: r.taskId, task: re.task_id });
    }
    this.bus.deliver(
      this.agents.map((a) => ({ id: a.id, pos: a.body.pos })),
      this.rng,
      this.radio,
    );

    for (const a of this.agents) {
      const cmd = a.controller.update({
        time: this.time,
        dt,
        body: a.body,
        inbox: this.bus.take(a.id),
        obstacles: this.obstacles,
        planner: this.planner,
        tasks: this.board,
        world: this.world,
        energy: this.energy,
        capacityKg: a.capacityKg,
        socReserve: this.scenario.policy.soc_reserve,
      });
      for (const m of cmd.outbox) this.bus.broadcast(a.id, a.body.pos, m);
      for (const e of cmd.events) this.onAgentEvent(a, e);
      this.integrate(a, cmd.velocity, cmd.charging, dt);
      this.sampleTrails(a, dt);
    }

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
    if (b.pos.y < 0.05) {
      b.pos.y = 0.05;
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
        this.note('power', `${a.id} charging at ${a.pad.id} (${a.body.battery.toFixed(0)}%)`, a.id, 'charging', { pad: a.pad.id, soc: Math.round(a.body.battery) });
        break;
      case 'charged':
        this.note('power', `${a.id} charged`, a.id, 'charged', {});
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

  /** Pairs of agent indices currently within radio range (for the comm-link overlay). */
  links(): [number, number][] {
    const out: [number, number][] = [];
    for (let i = 0; i < this.agents.length; i++) {
      for (let j = i + 1; j < this.agents.length; j++) {
        const a = this.agents[i].body.pos;
        const b = this.agents[j].body.pos;
        const range = this.radio.hasZones ? SIM.commRange * this.radio.link(a, b).rangeFactor : SIM.commRange;
        if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= range) out.push([i, j]);
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
      drones,
      events: this.log.slice(-14).reverse(),
      canAddDrone: this.canAddDrone,
      siteLoad,
      tasks: this.board.stats(this.time),
      faultsPending: this.faults.pending,
      faultsFired: this.faults.fired.map((f) => ({ t: f.t, type: f.def.type })),
      openTasks: openTasks.slice(0, 40),
      closedZones: this.obstacles.allNoFly.filter((z) => z.active && (z.source === 'fault' || z.closedFrom !== undefined)).map((z) => z.id),
    };
  }
}
