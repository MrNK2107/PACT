import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { createWorld, inNoFly } from '../world/buildWorld';
import { SimulationEngine } from './SimulationEngine';
import { ObstacleManager } from './ObstacleManager';
import { computeAvoidance, PathPlanner } from './PathPlanner';
import { SIM } from './config';

/** Small world for the simulation runs (fast); the default 4 km world is exercised in world.test.ts. */
const SCN = getScenario('test_small');
const SMALL = worldConfigFrom(SCN);
const world = createWorld(SMALL);

describe('world (small)', () => {
  it('is deterministic for a seed', () => {
    const w2 = createWorld(SMALL);
    expect(w2.buildings.length).toBe(world.buildings.length);
    expect(w2.buildings[10].bounds).toEqual(world.buildings[10].bounds);
    expect(w2.trees.length).toBe(world.trees.length);
    expect(w2.stats).toEqual(world.stats);
  });

  it('has unique stable ids and the required entity classes', () => {
    const ids = [...world.buildings, ...world.depots, ...world.pads, ...world.dropPoints].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(world.depots.length).toBe(3);
    expect(world.pads.length).toBe(6);
    expect(world.dropPoints.length).toBeGreaterThanOrEqual(20);
    expect(world.clusters.length).toBeGreaterThanOrEqual(5);
    expect(new Set(world.buildings.map((b) => b.zone)).size).toBeGreaterThanOrEqual(3);
  });

  it('keeps landing sites clear of no-fly zones and building volumes', () => {
    const om = new ObstacleManager(world);
    const sites = [...world.depots.flatMap((d) => d.handoff), ...world.dropPoints.map((d) => d.pos), ...world.pads.map((p) => p.pos)];
    for (const s of sites) {
      expect(inNoFly(world, s.x, s.z, 3, false)).toBe(false);
      expect(om.insideSolid({ x: s.x, y: s.y + 0.05, z: s.z }, 0.2, ['building', 'crane', 'utility'])).toBeNull();
    }
  });
});

describe('planner', () => {
  it('finds routes from depots to nearby drop points', () => {
    const om = new ObstacleManager(world);
    const planner = new PathPlanner(om, world.bounds);
    for (const d of world.depots) {
      const from = world.pads.find((p) => p.id === d.padIds[0])!.pos;
      const sites = world.dropPoints.filter((s) => Math.hypot(s.pos.x - from.x, s.pos.z - from.z) < 900);
      expect(sites.length).toBeGreaterThan(5);
      for (const s of sites) expect(planner.plan(from, s.pos, 28), `${d.id}->${s.id}`).not.toBeNull();
    }
  });
});

describe('local avoidance', () => {
  // dm_healthy (pact, t = 382.7 s): A05 climbed out past A07, which hovered waiting for a site and yielded. The old
  // yield sidestepped to the right of the bearing to the priority holder, which here is towards the holder's track:
  // 2.9 m at closest approach. The yielder now sidesteps perpendicular to the moving holder's track, away from it.
  const om = new ObstacleManager(world);
  const far = { x: world.bounds.minX + 40, y: 100, z: world.bounds.minZ + 40 };
  function encounter(holderStart: { x: number; z: number }, holderVel: { x: number; z: number }) {
    const y = { pos: { ...far }, vel: { x: 0, y: 0, z: 0 } };
    const h = { pos: { x: far.x + holderStart.x, y: far.y, z: far.z + holderStart.z }, vel: { x: holderVel.x, y: 0, z: holderVel.z } };
    let minD = Infinity;
    let firstSide: number | null = null;
    for (let i = 0; i < 20 * 5; i++) {
      const res = computeAvoidance({ id: 'A07', pos: y.pos, priority: 1, terminal: false, desired: { x: 0, y: 0, z: 0 }, maxSpeed: SIM.cruiseSpeed, neighbors: [{ id: 'A05', pos: { ...h.pos }, vel: { ...h.vel }, priority: 2 }], obstacles: om });
      if (firstSide === null && res.yielding) firstSide = res.velocity.x * -holderVel.z + res.velocity.z * holderVel.x;
      // acceleration-limited like the engine
      const dv = { x: res.velocity.x - y.vel.x, y: res.velocity.y - y.vel.y, z: res.velocity.z - y.vel.z };
      const dl = Math.hypot(dv.x, dv.y, dv.z);
      const k = dl > SIM.maxAccel * 0.05 ? (SIM.maxAccel * 0.05) / dl : 1;
      y.vel = { x: y.vel.x + dv.x * k, y: y.vel.y + dv.y * k, z: y.vel.z + dv.z * k };
      y.pos = { x: y.pos.x + y.vel.x * 0.05, y: y.pos.y + y.vel.y * 0.05, z: y.pos.z + y.vel.z * 0.05 };
      h.pos = { x: h.pos.x + h.vel.x * 0.05, y: h.pos.y, z: h.pos.z + h.vel.z * 0.05 };
      minD = Math.min(minD, Math.hypot(y.pos.x - h.pos.x, y.pos.y - h.pos.y, y.pos.z - h.pos.z));
    }
    return { minD, firstSide: firstSide ?? 0 };
  }

  it('a hovering yielder steps off a passing priority holder\'s track, away from it, on either side', () => {
    for (const side of [-1, 1]) {
      // the holder passes 3 m to one side of the yielder, moving along +x at 8 m/s
      const r = encounter({ x: -12, z: 3 * side }, { x: 8, z: 0 });
      // lateral velocity (left of the holder's track is +) points away from the holder's side
      expect(Math.sign(r.firstSide), `side ${side}`).toBe(-side);
      expect(r.minD, `side ${side}`).toBeGreaterThan(SIM.hardCollisionDist + 2);
    }
  });

  // dm_healthy (pact, t = 639.6 s, after the TC-09 hardening): A04 (yielder) and A08 (priority holder) met nearly head
  // on at cruise speed, A04 about 1.3 m left of A08's track. A04 stepped off the track to its own side (left), and A08
  // shared the lateral burden "right of its bearing to A04", which in a near head-on pass is also left: 2.9 m. The
  // holder now steps perpendicular to its own track, away from the yielder's side (3000 random two-drone encounters:
  // same 16 losses of separation, near misses < 6 m down from 94 to 56).
  it("a priority holder in a near head-on pass sidesteps away from the yielder's side of its track", () => {
    for (const side of [-1, 1]) {
      const h = { x: far.x, y: far.y, z: far.z };
      const y = { x: far.x + 30, y: far.y, z: far.z + 3.5 * side };
      const res = computeAvoidance({ id: 'A08', pos: h, priority: 2, terminal: false, desired: { x: 14.9, y: 0, z: 1.3 * side }, maxSpeed: SIM.cruiseSpeed, neighbors: [{ id: 'A04', pos: y, vel: { x: -15, y: 0, z: -1.2 * side }, priority: 1 }], obstacles: om });
      expect(res.yielding).toBe(false);
      expect(res.avoiding).toBe(true);
      // lateral velocity relative to the holder's own track (left = +): away from the yielder's side
      const lateral = (res.velocity.z * 14.9 - res.velocity.x * 1.3 * side) / Math.hypot(14.9, 1.3);
      expect(Math.sign(lateral), `side ${side}`).toBe(-side);
    }
  });
});

describe('simulation', () => {
  for (const n of [3, 6]) {
    it(`delivers packages with decentralised coordination — ${n} drones, no loss of separation`, () => {
      const eng = new SimulationEngine(createWorld(SMALL), scenarioWith(SCN, { fleet: { n_drones: n } }));
      eng.start();
      eng.setSpeed(1);
      for (let i = 0; i < 20 * 600; i++) eng.update(0.05); // 10 simulated minutes
      const s = eng.snapshot();
      // eslint-disable-next-line no-console
      console.log(n, JSON.stringify({ completed: s.completed, pending: s.pending, conflicts: s.totalConflicts, minSep: s.minSeparation?.toFixed(1), coll: s.collisions, hits: s.structureHits, charging: s.charging }), s.drones.map((d) => `${d.id}:${d.phase}:${d.battery.toFixed(0)}:${d.delivered}`).join(' '));
      expect(s.completed).toBeGreaterThan(n * 2);
      expect(s.collisions).toBe(0);
      expect(s.structureHits).toBe(0);
      const owners = new Set<string>();
      for (const d of s.drones) {
        if (d.taskId) {
          expect(owners.has(d.taskId)).toBe(false);
          owners.add(d.taskId);
        }
      }
    });
  }

  it('supports adding/removing drones and reset', () => {
    const eng = new SimulationEngine(createWorld(SMALL), scenarioWith(SCN, { fleet: { n_drones: 3 } }));
    expect(eng.addDrone()).not.toBeNull();
    expect(eng.agents.length).toBe(4);
    eng.removeDrone();
    expect(eng.agents.length).toBe(3);
    eng.reset();
    expect(eng.time).toBe(0);
    expect(eng.status).toBe('idle');
  });
});

describe('determinism and faults', () => {
  const run = (scn: ReturnType<typeof scenarioWith>, seconds: number) => {
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * seconds; i++) eng.update(0.05);
    return eng;
  };

  it('same scenario + seed → identical event logs (AT-01)', () => {
    const scn = scenarioWith(SCN, { fleet: { n_drones: 5 } });
    const a = run(scn, 300);
    const b = run(scn, 300);
    expect(a.events.length).toBeGreaterThan(50);
    expect(a.eventHash()).toBe(b.eventHash());
    expect(a.exportEventsJsonl()).toBe(b.exportEventsJsonl());
  });

  it('urgent_job_burst adds priority-1 tasks inside the window and idle drones re-auction', () => {
    const scn = scenarioWith(SCN, { fleet: { n_drones: 4 }, workload: { arrival_rate_per_min: 0.5 }, faults: [{ t: 60, type: 'urgent_job_burst', n: 8, window_s: 30, priority: 1 }] });
    const eng = run(scn, 100);
    const urgent = eng.board.tasks.filter((t) => t.priority === 1 && t.created_at >= 60 && t.created_at <= 90);
    expect(urgent.length).toBe(8);
    expect(eng.events.some((e) => e.type === 'fault_urgent_job_burst')).toBe(true);
  });

  it('close_zone activates a closable zone and drones stay out of it', () => {
    const w = createWorld(worldConfigFrom(SCN));
    const stadium = w.noFlyZones.find((z) => z.closable);
    // an incident polygon around a busy drop point, well away from every depot
    const far = w.dropPoints.filter((d) => w.depots.every((dep) => Math.hypot(dep.pos.x - d.pos.x, dep.pos.z - d.pos.z) > 350));
    const c = far[Math.floor(far.length / 2)].pos;
    const poly = [{ x: c.x - 150, y: c.z - 150 }, { x: c.x + 150, y: c.z - 150 }, { x: c.x + 150, y: c.z + 150 }, { x: c.x - 150, y: c.z + 150 }];
    const scn = scenarioWith(SCN, { fleet: { n_drones: 4 }, faults: [{ t: 30, type: 'close_zone', id: stadium ? stadium.id : 'stadium', until: 400 }, { t: 40, type: 'close_zone', name: 'Incident', polygon: poly, until: 300 }] });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    let violations = 0;
    for (let i = 0; i < 20 * 280; i++) {
      eng.update(0.05);
      if (eng.time > 70) {
        for (const a of eng.agents) {
          if (!a.airborne) continue;
          if (eng.obstacles.inActiveNoFly(a.body.pos.x, a.body.pos.z, -4)) violations++;
        }
      }
    }
    expect(eng.obstacles.allNoFly.some((z) => z.source === 'fault' && z.active)).toBe(true);
    if (stadium) expect(eng.obstacles.allNoFly.find((z) => z.id === stadium.id)!.active).toBe(true);
    expect(violations).toBe(0);
    for (let i = 0; i < 20 * 40; i++) eng.update(0.05); // past `until`
    expect(eng.obstacles.allNoFly.some((z) => z.source === 'fault' && z.active)).toBe(false);
  });

  it('battery_drain accelerates depletion and kill_drone removes the drone and recovers its task', () => {
    const base = scenarioWith(SCN, { fleet: { n_drones: 4 }, faults: [] });
    const drained = scenarioWith(SCN, { fleet: { n_drones: 4 }, faults: [{ t: 0, type: 'battery_drain', id: 'all', factor: 2 }] });
    const a = run(base, 120);
    const b = run(drained, 120);
    const mean = (e: SimulationEngine) => e.agents.reduce((s, d) => s + d.body.battery, 0) / e.agents.length;
    expect(mean(b)).toBeLessThan(mean(a));
    const killed = scenarioWith(SCN, { fleet: { n_drones: 4 }, faults: [{ t: 45, type: 'kill_drone', id: 'A01' }] });
    const c = run(killed, 200);
    expect(c.agents.some((d) => d.id === 'A01')).toBe(false);
    expect(c.agents.length).toBe(3);
    expect(c.events.some((e) => e.type === 'fault_kill_drone')).toBe(true);
    // every task A01 held is either re-opened, re-ordered or delivered by someone else — never stuck with A01
    for (const t of c.board.tasks) expect(t.owner === 'A01' && t.state !== 'ABORTED' && t.state !== 'DELIVERED').toBe(false);
  });
});
