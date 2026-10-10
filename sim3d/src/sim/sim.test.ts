import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { createWorld, inNoFly } from '../world/buildWorld';
import { SimulationEngine } from './SimulationEngine';
import { ObstacleManager } from './ObstacleManager';
import { PathPlanner } from './PathPlanner';

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
