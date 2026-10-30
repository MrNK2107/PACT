import type { PadData, Vec3 } from '../world/types';
import { AgentCoordinator } from './AgentCoordinator';
import { SIM } from './config';
import { computeAvoidance, type NeighborInfo, type Waypoint } from './PathPlanner';
import type { Task } from './Task';
import type { Allocation } from './systems';
import type { AgentController, Command, DronePhase, Percept, SiteStage } from './types';

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

function hdist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Reference decentralised drone brain. A finite-state machine driven only by:
 *   - the drone's own body state,
 *   - heartbeats / claims that arrived over the simulated radio (neighbour discovery),
 *   - local sensing (static & moving obstacles),
 *   - the shared order board (an environment service: epoch-fenced claims, depot pickup arbitration).
 * There is no fleet-level controller: task allocation is bid/claim/back-off between neighbours and
 * collision conflicts are resolved by a priority order that every drone evaluates identically.
 * Lease discipline (I3): the drone stops acting on a pre-pickup task the moment it no longer owns it.
 * Replace this class (implement `AgentController`) to try other algorithms.
 */
export class LocalAgentController implements AgentController {
  phase: DronePhase = 'idle';
  taskId: string | null = null;
  carrying = false;
  route: Waypoint[] = [];
  routeIndex = 0;
  routeVersion = 0;
  cruiseAlt = 0;
  avoiding = false;
  yielding = false;
  conflictWith: string[] = [];
  holdReason: string | null = null;
  neighborCount = 0;
  neighbors: NeighborInfo[] = [];
  priority = 1;
  delivered = 0;
  destination: Vec3 | null = null;
  destinationLabel: string | null = null;

  private coord: AgentCoordinator;
  private task: Task | null = null;
  private timer = 0;
  private idleSince = 0;
  private nextChoose = 0;
  private backoffUntil = 0;
  private stuckT = 0;
  private stuckBest = Infinity;
  private homePad: PadData | null = null;
  private holding = false;
  private watchdogHits = 0;
  private seenUrgent = -1;
  private lastZoneCheck = -Infinity;
  private intent: Vec3 = ZERO;
  private lastHoldT = -Infinity;
  private padRetryAt = 0;
  private seenCap = -1;
  private padWaitLogged = false;

  constructor(
    readonly id: string,
    readonly homePadId: string,
    private layerAlt: number,
    /** How this drone gets work: PACT auction (default), central hub dispatch, or greedy nearest (baselines). */
    readonly allocation: Allocation = 'auction',
  ) {
    this.coord = new AgentCoordinator(id);
  }

  /** The pad this drone currently uses (the preferred pad unless it was unavailable). */
  get padId(): string {
    return this.homePad?.id ?? this.homePadId;
  }

  /** The task this drone currently holds (live board record). */
  get currentTask(): Task | null {
    return this.task;
  }

  update(p: Percept): Command {
    const now = p.time;
    const out: Command = { velocity: ZERO, outbox: [], events: [], charging: false };
    if (!this.homePad) this.homePad = p.world.pads.find((x) => x.id === this.homePadId)!;
    this.coord.ingest(p.inbox, now);
    this.neighbors = this.coord.neighbors(now);
    // drones I can sense but have not heard from (radio dead zone, packet loss): same priority as mine, so the
    // id tie-break gives both sides complementary roles without any message
    if (p.sensed?.length) {
      const heard = new Set(this.neighbors.map((n) => n.id));
      for (const s of p.sensed) if (!heard.has(s.id)) this.neighbors.push({ id: s.id, pos: s.pos, vel: s.vel, priority: this.priority });
    }
    this.neighborCount = this.coord.neighborCount;
    // a drone waiting for a site always yields to one that is departing / flying through;
    // urgent parcels and low batteries outrank
    this.priority = now - this.lastHoldT < 4 ? 0 : (this.carrying ? 2 : 1) + (p.body.battery < 25 ? 3 : 0) + (this.task?.priority === 1 ? 2 : 0);
    this.avoiding = false;
    this.yielding = false;
    this.conflictWith = [];
    this.holdReason = null;
    this.intent = ZERO;

    // zombie-stop (I3): if my pre-pickup lease lapsed (the board re-opened or re-assigned the task), stop.
    if (this.task && !this.carrying && !p.tasks.holds(this.task.task_id, this.id)) {
      out.events.push({ type: 'zombie_stop', taskId: this.task.task_id, detail: `epoch ${this.task.epoch}` });
      this.dropTask();
      this.backoffUntil = now + 2;
      if (this.phase === 'to_pickup' || this.phase === 'loading') this.planReturn(p, out);
      else this.enterIdle(now);
    }
    // event-driven re-auction on urgent arrivals (REQ-AUC-003)
    if (p.tasks.urgentCounter !== this.seenUrgent) {
      this.seenUrgent = p.tasks.urgentCounter;
      if (this.phase === 'idle') this.nextChoose = now;
    }

    switch (this.phase) {
      case 'idle':
        this.doIdle(p, out);
        break;
      case 'claiming':
        this.doClaiming(p, out);
        break;
      case 'to_pickup':
      case 'to_delivery':
      case 'returning':
        this.doFly(p, out);
        break;
      case 'loading':
      case 'unloading':
        this.doWork(p, out);
        break;
      case 'charging':
        this.doCharge(p, out);
        break;
    }

    if (this.coord.heartbeatDue(now)) {
      let site: Vec3 | null = null;
      let stage: SiteStage | null = null;
      if (this.phase === 'to_pickup' || this.phase === 'to_delivery') {
        const wp = this.route[this.routeIndex];
        if (wp && this.routeIndex >= this.route.length - 2) {
          site = this.destination;
          stage = wp.kind === 'land' ? 'land' : 'approach';
        }
      } else if (this.phase === 'loading' || this.phase === 'unloading') {
        site = this.destination;
        stage = 'work';
      }
      // lease renewal rides on the heartbeat (pre-pickup only; post-pickup ownership is sticky)
      if (this.task && !this.carrying) p.tasks.renew(this.task.task_id, this.id, now);
      out.outbox.push({ type: 'HEARTBEAT', from: this.id, pos: { ...p.body.pos }, vel: { ...p.body.vel }, intent: { ...this.intent }, priority: this.priority, phase: this.phase, site, stage, t: now });
    }
    return out;
  }

  // ---- states ------------------------------------------------------------------------------------------

  private atHome(p: Percept): boolean {
    const pad = this.homePad!;
    return pad.enabled !== false && hdist(p.body.pos, pad.pos) < 3 && p.body.pos.y < pad.pos.y + 1;
  }

  private enterIdle(now: number): void {
    this.phase = 'idle';
    this.idleSince = now;
    this.nextChoose = now + 0.2;
  }

  private doIdle(p: Percept, out: Command): void {
    const now = p.time;
    const home = this.atHome(p);
    if (home && p.body.battery < 60) {
      this.phase = 'charging';
      out.events.push({ type: 'charging' });
      return;
    }
    if (!home && p.body.battery < SIM.returnThreshold) {
      this.planReturn(p, out);
      return;
    }
    if (now >= this.nextChoose && now >= this.backoffUntil) {
      this.nextChoose = now + 0.3;
      const ctx = {
        pos: p.body.pos,
        battery: p.body.battery,
        capacityKg: p.capacityKg,
        now,
        energy: p.energy,
        wind: p.world.wind,
        homePad: this.homePad!.pos,
        socReserve: p.socReserve,
        obstacles: p.obstacles,
      };
      if (this.allocation === 'central') {
        // baselines: the hub dispatches; with the hub down there is nothing to do but hold / go home
        const a = p.hub?.assignmentFor(this.id) ?? null;
        if (a) {
          p.hub!.consume(this.id);
          const task = p.tasks.open().find((t) => t.task_id === a.taskId);
          if (task && p.tasks.claim(task.task_id, this.id, -a.score, now)) {
            this.acceptClaim(p, out, task, -a.score);
            return;
          }
        }
      } else if (this.allocation === 'greedy') {
        const choice = this.coord.chooseNearest(p.tasks.open(), ctx);
        if (choice && p.tasks.claim(choice.task.task_id, this.id, choice.cost, now)) {
          this.acceptClaim(p, out, choice.task, choice.cost);
          return;
        }
      } else {
        // cbba_plain: the same auction, but over the tasks this drone believes are free (no board fencing)
        const pool = this.allocation === 'cbba' ? p.tasks.believedOpen(this.coord.heardIds(), this.id) : p.tasks.open();
        const choice = this.coord.chooseTask(pool, ctx, p.tasks.suspected ? (id) => p.tasks.suspected!(id) : undefined);
        if (choice) {
          out.outbox.push(this.coord.startClaim(choice.task, choice.cost, now));
          this.phase = 'claiming';
          return;
        }
      }
      // nothing feasible: top up while waiting at home
      if (home && p.body.battery < SIM.chargeTarget - 5 && p.tasks.open().length > 0) {
        this.phase = 'charging';
        out.events.push({ type: 'charging' });
        return;
      }
    }
    if (!home && now - this.idleSince > 1.5) this.planReturn(p, out);
  }

  private doClaiming(p: Percept, out: Command): void {
    const now = p.time;
    if (this.coord.outbid(p.tasks.suspected ? (id) => p.tasks.suspected!(id) : undefined)) {
      this.coord.endClaim();
      this.phase = 'idle';
      this.nextChoose = now + 0.25 + (hash(this.id) % 5) * 0.06;
      return;
    }
    if (!this.coord.claimWindowElapsed(now)) return;
    const a = this.coord.attempt!;
    this.coord.endClaim();
    if (!p.tasks.claim(a.task.task_id, this.id, a.cost, now)) {
      this.phase = 'idle';
      this.nextChoose = now + 0.2;
      return;
    }
    this.acceptClaim(p, out, a.task, a.cost);
  }

  /** The board granted my claim: fly to the pickup (or hand the task back if no route exists). */
  private acceptClaim(p: Percept, out: Command, task: Task, cost: number): void {
    const now = p.time;
    this.task = task;
    this.taskId = task.task_id;
    out.events.push({ type: 'claimed', taskId: task.task_id, detail: `P${task.priority}, score ${(-cost).toFixed(2)}, epoch ${task.epoch}` });
    if (this.startRoute(p, out, task.pickup, 'to_pickup', task.origin_depot)) {
      p.pads?.release(this.id); // leaving the pad: it is free for others while I am away
    } else {
      p.tasks.release(task.task_id, this.id, now);
      this.dropTask();
      this.phase = 'idle';
      this.backoffUntil = now + 4;
    }
  }

  private doFly(p: Percept, out: Command): void {
    const now = p.time;
    const pos = p.body.pos;
    // an altitude ceiling appeared or changed: re-plan below it (from a position clamped under the ceiling)
    if (p.obstacles.capVersion !== this.seenCap) {
      const first = this.seenCap === -1;
      this.seenCap = p.obstacles.capVersion;
      if (!first && this.destination) {
        const ceil = p.obstacles.ceilingAt(pos.x, pos.z);
        const from = ceil < Infinity ? { x: pos.x, y: Math.min(pos.y, Math.max(1, ceil - 11)), z: pos.z } : pos;
        const plan = p.planner.plan(from, this.destination, this.layerFor(p, this.destination));
        if (plan) {
          this.setRoute(plan.waypoints, plan.cruiseAlt);
          out.events.push({ type: 'replanned', detail: 'altitude ceiling' });
        } else if (this.phase !== 'returning') {
          this.abortTask(p, out, 'no route under the altitude ceiling');
          return;
        }
      }
    }
    const wp = this.route[this.routeIndex];
    if (!wp) {
      this.onRouteEnd(p, out);
      return;
    }
    // airspace closed around my destination after I committed: give the task back and go home
    if (this.destination && this.phase !== 'returning' && now - this.lastZoneCheck > 1) {
      this.lastZoneCheck = now;
      if (p.obstacles.inActiveNoFly(this.destination.x, this.destination.z, 2)) {
        this.abortTask(p, out, 'destination inside closed airspace');
        return;
      }
    }
    const st = steer(pos, wp);
    let desired = st.desired;
    let held = false;
    let advanced = false;
    this.holding = false;

    // Site etiquette: if the destination column is occupied, hold at a standoff distance instead of
    // flying into it (a neighbour may be climbing out or landing there).
    if (this.destination && this.phase !== 'returning' && (wp.kind === 'cruise' || wp.kind === 'approach')) {
      const dh = hdist(pos, this.destination);
      if (dh < 30 && this.coord.siteOccupied(this.destination, this.priority, this.cruiseAlt, now)) {
        held = true;
        this.holding = true;
        this.lastHoldT = now;
        this.holdReason = 'waiting for site';
        if (dh < 12) {
          const k = 4 / Math.max(dh, 0.5);
          desired = { x: (pos.x - this.destination.x) * k, y: (this.cruiseAlt - pos.y) * 0.5, z: (pos.z - this.destination.z) * k };
        } else desired = { x: 0, y: (this.cruiseAlt - pos.y) * 0.5, z: 0 };
      }
    }

    if (held) {
      // hold: neither advance nor land
    } else if (st.arrived) {
      if (wp.kind === 'land') {
        this.onRouteEnd(p, out);
        return;
      } else {
        this.routeIndex++;
        this.stuckBest = Infinity;
        this.stuckT = now;
        advanced = true;
      }
    }

    this.intent = desired;
    const terminal = wp.kind === 'climb' || wp.kind === 'land';
    const res = computeAvoidance({
      id: this.id,
      pos,
      priority: this.priority,
      terminal,
      desired,
      maxSpeed: SIM.cruiseSpeed,
      neighbors: this.neighbors,
      obstacles: p.obstacles,
    });
    this.avoiding = res.avoiding;
    this.yielding = res.yielding;
    this.conflictWith = res.conflictWith;
    out.velocity = res.velocity;

    // progress watchdog -> replan from here on a higher layer; give up after repeated failures
    if (held || advanced) {
      this.stuckT = now;
    } else {
      const d = Math.hypot(wp.pos.x - pos.x, wp.pos.y - pos.y, wp.pos.z - pos.z);
      if (d < this.stuckBest - 0.5) {
        this.stuckBest = d;
        this.stuckT = now;
      } else if (now - this.stuckT > 12 && this.destination) {
        this.stuckT = now;
        this.watchdogHits++;
        if (this.watchdogHits > 4 && this.phase !== 'returning') {
          this.abortTask(p, out, 'unreachable destination');
          return;
        }
        const plan = p.planner.plan(pos, this.destination, this.cruiseAlt + 9);
        if (plan) {
          this.setRoute(plan.waypoints, plan.cruiseAlt);
          out.events.push({ type: 'replanned', detail: 'progress watchdog' });
        }
      }
    }
  }

  private onRouteEnd(p: Percept, out: Command): void {
    const now = p.time;
    switch (this.phase) {
      case 'to_pickup':
        this.phase = 'loading';
        this.timer = now + SIM.loadTime;
        break;
      case 'to_delivery':
        this.phase = 'unloading';
        this.timer = now + SIM.unloadTime;
        break;
      case 'returning':
        out.events.push({ type: 'landed' });
        if (p.body.battery < 85) {
          this.phase = 'charging';
          out.events.push({ type: 'charging' });
        } else this.enterIdle(now);
        break;
      default:
        this.enterIdle(now);
    }
  }

  private doWork(p: Percept, out: Command): void {
    const now = p.time;
    if (!this.task) {
      // the task was dropped while I was working (lease lost, abort): do not hold the site
      this.enterIdle(now);
      return;
    }
    if (now < this.timer) return;
    if (this.phase === 'loading') {
      // depot arbitration: only the highest valid epoch's owner receives the parcel (REQ-OWN-003)
      const verdict = p.tasks.pickup(this.task.task_id, this.id, this.task.epoch, now);
      // replica board: the PICKUP_REQ is on its way to the origin depot; keep waiting at the bay (baselines never wait)
      if (verdict === 'PENDING') return;
      if (verdict === 'TASK_TAKEN') {
        out.events.push({ type: 'task_taken', taskId: this.task.task_id });
        this.dropTask();
        this.backoffUntil = now + 1;
        this.enterIdle(now);
        return;
      }
      this.carrying = true;
      out.events.push({ type: 'picked_up', taskId: this.task.task_id });
      if (!this.startRoute(p, out, this.task.drop, 'to_delivery', this.task.dropId)) {
        this.phase = 'loading';
        this.timer = now + 3;
      }
    } else {
      p.tasks.complete(this.task.task_id, this.id, now);
      out.events.push({ type: 'delivered', taskId: this.task.task_id, detail: now > this.task.deadline ? `late by ${(now - this.task.deadline).toFixed(0)} s` : 'on time' });
      this.carrying = false;
      this.delivered++;
      this.dropTask();
      this.route = [];
      this.routeIndex = 0;
      this.routeVersion++;
      this.enterIdle(now);
    }
  }

  private doCharge(p: Percept, out: Command): void {
    if (this.homePad!.enabled === false) {
      // the charger went out of service under me: stop charging; the idle logic relocates to a working pad
      this.enterIdle(p.time);
      return;
    }
    out.charging = true;
    if (p.body.battery >= SIM.chargeTarget) {
      out.events.push({ type: 'charged' });
      this.enterIdle(p.time);
    }
  }

  // ---- helpers -----------------------------------------------------------------------------------------

  private dropTask(): void {
    this.task = null;
    this.taskId = null;
    this.carrying = false;
    this.destination = null;
    this.destinationLabel = null;
  }

  /** Give the current task back (re-opened / re-ordered on the board) and head home. */
  private abortTask(p: Percept, out: Command, reason: string): void {
    if (this.task) {
      p.tasks.release(this.task.task_id, this.id, p.time);
      out.events.push({ type: 'aborted', taskId: this.task.task_id, detail: reason });
    }
    this.dropTask();
    this.route = [];
    this.routeIndex = 0;
    this.routeVersion++;
    this.watchdogHits = 0;
    this.backoffUntil = p.time + 6;
    this.planReturn(p, out);
  }

  /**
   * Asks the depot book for a pad: my current pad if it is enabled and free (the only case without outages),
   * otherwise the nearest enabled free pad. Without a book every drone keeps its own pad.
   */
  private acquirePad(p: Percept): PadData | null {
    const cur = this.homePad!;
    const book = p.pads;
    if (!book) return cur;
    if (book.reserve(cur.id, this.id)) return cur;
    const alt = book.nearestFree(p.body.pos, this.id);
    return alt && book.reserve(alt.id, this.id) ? alt : null;
  }

  private planReturn(p: Percept, out: Command): void {
    const now = p.time;
    if (now < this.padRetryAt) return;
    const pad = this.acquirePad(p);
    if (!pad) {
      // no working pad is free: wait where I am and ask again shortly
      this.padRetryAt = now + 3;
      if (!this.padWaitLogged) {
        this.padWaitLogged = true;
        out.events.push({ type: 'pad_unavailable', detail: `no free enabled pad (preferred ${this.homePad!.id})` });
      }
      this.leaveDeadPhase(now);
      return;
    }
    this.padWaitLogged = false;
    if (pad.id !== this.homePad!.id) {
      out.events.push({ type: 'pad_changed', detail: `${this.homePad!.id} -> ${pad.id}` });
      this.homePad = pad;
    }
    if (!this.startRoute(p, out, pad.pos, 'returning', pad.id)) {
      p.pads?.release(this.id);
      this.backoffUntil = now + 3;
      // no route home from here (e.g. stopped under a new ceiling): ask again in a few seconds, not every tick
      this.padRetryAt = now + 3;
      this.leaveDeadPhase(now);
    }
  }

  /** A drone with no task that could not start its way home must not stay in a task phase: wait idle and retry. */
  private leaveDeadPhase(now: number): void {
    if (!this.task && (this.phase === 'to_pickup' || this.phase === 'loading' || this.phase === 'to_delivery' || this.phase === 'unloading' || this.phase === 'claiming')) this.enterIdle(now);
  }

  /** My preferred cruise layer, lowered to fit under any altitude ceiling over my position or my destination. */
  private layerFor(p: Percept, dest: Vec3): number {
    const c = Math.min(p.obstacles.ceilingAt(p.body.pos.x, p.body.pos.z), p.obstacles.ceilingAt(dest.x, dest.z));
    return c < Infinity ? Math.min(this.layerAlt, Math.max(12, c - 9)) : this.layerAlt;
  }

  private startRoute(p: Percept, out: Command, dest: Vec3, phase: DronePhase, label: string): boolean {
    const plan = p.planner.plan(p.body.pos, dest, this.layerFor(p, dest));
    if (!plan) {
      out.events.push({ type: 'plan_failed', detail: label });
      return false;
    }
    this.setRoute(plan.waypoints, plan.cruiseAlt);
    this.destination = dest;
    this.destinationLabel = label;
    this.phase = phase;
    this.stuckBest = Infinity;
    this.stuckT = p.time;
    this.watchdogHits = 0;
    return true;
  }

  private setRoute(wps: Waypoint[], alt: number): void {
    this.route = wps;
    this.routeIndex = 0;
    this.cruiseAlt = alt;
    this.routeVersion++;
  }
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Waypoint-following velocity command with per-kind arrival criteria. */
function steer(pos: Vec3, wp: Waypoint): { desired: Vec3; arrived: boolean } {
  const dx = wp.pos.x - pos.x;
  const dy = wp.pos.y - pos.y;
  const dz = wp.pos.z - pos.z;
  const dh = Math.hypot(dx, dz);
  const d3 = Math.hypot(dx, dy, dz);
  if (wp.kind === 'land') {
    const above = pos.y - wp.pos.y;
    const arrived = dh < 0.8 && above < 0.12;
    const hv = Math.min(3, dh * 1.2);
    const vy = dh < 2 ? -Math.min(3, Math.max(0.5, above * 0.8)) : 0;
    return { desired: { x: dh > 1e-3 ? (dx / dh) * hv : 0, y: vy, z: dh > 1e-3 ? (dz / dh) * hv : 0 }, arrived };
  }
  const arrived = d3 < (wp.kind === 'climb' ? 2.0 : wp.kind === 'approach' ? 2.5 : 3.5);
  const speed = wp.kind === 'approach' ? Math.min(SIM.cruiseSpeed, Math.max(1.5, d3 * 0.8)) : SIM.cruiseSpeed;
  if (d3 < 1e-3) return { desired: ZERO, arrived };
  let vx = (dx / d3) * speed;
  let vy = (dy / d3) * speed;
  let vz = (dz / d3) * speed;
  if (Math.abs(vy) > SIM.maxVz) {
    const k = SIM.maxVz / Math.abs(vy);
    vx *= k;
    vy *= k;
    vz *= k;
  }
  return { desired: { x: vx, y: vy, z: vz }, arrived };
}
