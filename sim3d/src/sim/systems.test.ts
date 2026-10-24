import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import type { FaultDef, Scenario } from '../scenario/types';
import { createWorld } from '../world/buildWorld';
import { scoreTask, type ScoreContext } from './AgentCoordinator';
import { assignGreedy, CentralHub, type HubDrone } from './CentralHub';
import { SimulationEngine } from './SimulationEngine';
import { allocationOf, SYSTEM_IDS, type SystemId } from './systems';

/** TC-11 baselines: the central planner, the hub service, system selection and the kill_service fault. */

const BASE = getScenario('test_small');

function engine(system: SystemId, faults: FaultDef[] = []): SimulationEngine {
  const s: Scenario = { ...BASE, system, faults };
  return new SimulationEngine(createWorld(worldConfigFrom(s)), s);
}

function run(eng: SimulationEngine, seconds: number): SimulationEngine {
  eng.start();
  for (let i = 0; i < seconds * 20; i++) eng.update(0.05);
  return eng;
}

function hubDrones(eng: SimulationEngine, over: Partial<ScoreContext> = {}): HubDrone[] {
  return eng.agents.map((a) => ({
    id: a.id,
    ctx: { pos: a.body.pos, battery: a.body.battery, capacityKg: a.capacityKg, now: 0, energy: eng.energy, wind: eng.world.wind, homePad: a.pad.pos, socReserve: 0.2, obstacles: eng.obstacles, ...over },
  }));
}

describe('systems', () => {
  it('maps every system to an allocation mode', () => {
    expect(SYSTEM_IDS.map(allocationOf)).toEqual(['auction', 'central', 'central', 'greedy', 'cbba']);
  });

  it('scenario files may pick a system and unknown systems are rejected', () => {
    expect(scenarioWith(BASE, { system: 'central_full' }).system).toBe('central_full');
    expect(() => scenarioWith(BASE, { system: 'nope' as SystemId })).toThrow(/system must be one of/);
  });
});

describe('assignGreedy (central planner)', () => {
  const eng = engine('central_full');
  const open = eng.board.open();
  const drones = hubDrones(eng);

  it('gives each drone at most one task and each task at most one drone', () => {
    const out = assignGreedy(drones, open);
    expect(out.length).toBe(Math.min(drones.length, open.length));
    expect(new Set(out.map((a) => a.droneId)).size).toBe(out.length);
    expect(new Set(out.map((a) => a.taskId)).size).toBe(out.length);
  });

  it('takes the globally best (drone, task) pair first and is deterministic', () => {
    let best = -Infinity;
    for (const d of drones) for (const t of open) best = Math.max(best, scoreTask(t, d.ctx, 0)?.score ?? -Infinity);
    const out = assignGreedy(drones, open);
    expect(out[0].score).toBeCloseTo(best, 9);
    expect(assignGreedy([...drones].reverse(), [...open].reverse())).toEqual(out);
  });

  it('respects the hard constraints (payload, energy reserve)', () => {
    expect(assignGreedy(hubDrones(eng, { capacityKg: 0 }), open)).toEqual([]);
    expect(assignGreedy(hubDrones(eng, { battery: 10 }), open)).toEqual([]);
  });

  it('a killed hub hands out nothing and stops planning', () => {
    const hub = new CentralHub(2);
    expect(hub.due(0)).toBe(true);
    const out = hub.plan(0, drones, open);
    expect(hub.assignmentFor(out[0].droneId)).toEqual(out[0]);
    expect(hub.due(1)).toBe(false);
    hub.kill(1);
    expect(hub.assignmentFor(out[0].droneId)).toBeNull();
    expect(hub.due(10)).toBe(false);
    expect(hub.killedAt).toBe(1);
  });
});

describe('baseline systems in the engine', () => {
  it.each(['central_full', 'greedy_nearest'] as SystemId[])('%s delivers parcels without breaking I1', { timeout: 60000 }, (sys) => {
    const eng = run(engine(sys), 300);
    const delivered = eng.events.filter((e) => e.type === 'delivered').map((e) => (e.data as { task: string }).task);
    expect(delivered.length).toBeGreaterThanOrEqual(3);
    expect(new Set(delivered).size).toBe(delivered.length);
    if (sys === 'central_full') expect(eng.events.some((e) => e.type === 'hub_dispatch')).toBe(true);
    else expect(eng.hub).toBeNull();
  });

  it('kill_service(central_hub) stops new claims in central_hub_loss only', { timeout: 60000 }, () => {
    const faults: FaultDef[] = [{ t: 30, type: 'kill_service', name: 'central_hub' }];
    const lossy = run(engine('central_hub_loss', faults), 300);
    expect(lossy.hub!.alive).toBe(false);
    expect(lossy.events.some((e) => e.type === 'fault_kill_service')).toBe(true);
    expect(lossy.events.filter((e) => e.type === 'claimed' && e.t > 30.01)).toEqual([]);
    expect(lossy.events.filter((e) => e.type === 'hub_dispatch' && e.t > 30.01)).toEqual([]);

    const ideal = run(engine('central_full', faults), 300);
    expect(ideal.hub!.alive).toBe(true);
    expect(ideal.events.some((e) => e.type === 'claimed' && e.t > 30.01)).toBe(true);

    const pact = run(engine('pact', faults), 300);
    const k = pact.events.find((e) => e.type === 'fault' && (e.data as { type?: string }).type === 'kill_service');
    expect(k?.data).toMatchObject({ affected: false });
    expect(pact.events.some((e) => e.type === 'claimed' && e.t > 30.01)).toBe(true);
  });

  it('kill_service of an unknown service is reported as failed', () => {
    const eng = run(engine('pact', [{ t: 1, type: 'kill_service', name: 'billing' }]), 2);
    expect(eng.events.some((e) => e.type === 'fault_kill_service_failed')).toBe(true);
  });

  it.each(['central_hub_loss', 'greedy_nearest'] as SystemId[])('%s is deterministic (AT-01)', { timeout: 60000 }, (sys) => {
    const faults: FaultDef[] = [{ t: 40, type: 'kill_service', name: 'central_hub' }];
    expect(run(engine(sys, faults), 90).eventHash()).toBe(run(engine(sys, faults), 90).eventHash());
  });
});

describe('fleet size', () => {
  it('logs fleet_capped when the scenario asks for more drones than there are pads', () => {
    const s: Scenario = { ...BASE, fleet: { ...BASE.fleet, n_drones: 40, max_drones: 50 } };
    const eng = new SimulationEngine(createWorld(worldConfigFrom(s)), s);
    const capped = eng.events.find((e) => e.type === 'fleet_capped');
    expect(capped?.data).toMatchObject({ requested: 40, spawned: eng.agents.length });
    expect(eng.agents.length).toBeLessThan(40);
    expect(engine('pact').events.some((e) => e.type === 'fleet_capped')).toBe(BASE.fleet.n_drones > engine('pact').agents.length);
  });
});
