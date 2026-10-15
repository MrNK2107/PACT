import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenarioYaml, scenarioWith, worldConfigFrom } from '../scenario/load';
import { findMap } from '../map/registry';
import { getScenario } from '../scenario/registry';
import { createWorld, inNoFly } from '../world/buildWorld';
import type { PadData } from '../world/types';
import { PadBook } from './PadBook';
import { SimulationEngine } from './SimulationEngine';

const pad = (id: string, x: number, z: number): PadData => ({ id, pos: { x, y: 0.4, z }, radius: 3, rooftop: false, depotId: 'D1', enabled: true });

describe('PadBook', () => {
  it('grants one holder per pad and releases on request', () => {
    const b = new PadBook([pad('A', 0, 0), pad('B', 100, 0)]);
    expect(b.reserve('A', 'd1')).toBe(true);
    expect(b.reserve('A', 'd2')).toBe(false);
    expect(b.reserve('A', 'd1')).toBe(true);
    expect(b.holderOf('A')).toBe('d1');
    b.release('d1');
    expect(b.holderOf('A')).toBeNull();
    expect(b.reserve('A', 'd2')).toBe(true);
  });

  it('moves a drone to a new pad and frees the old one', () => {
    const b = new PadBook([pad('A', 0, 0), pad('B', 100, 0)]);
    b.reserve('A', 'd1');
    expect(b.reserve('B', 'd1')).toBe(true);
    expect(b.holderOf('A')).toBeNull();
    expect(b.padOf('d1')).toBe('B');
  });

  it('finds the nearest enabled free pad, with ties broken by id', () => {
    const b = new PadBook([pad('A', 0, 0), pad('B', 100, 0), pad('C', -100, 0), pad('D', 300, 0)]);
    b.reserve('A', 'd1');
    expect(b.nearestFree({ x: 10, y: 20, z: 0 }, 'd2')?.id).toBe('B'); // B and C tie at 110 and 110: id order
    b.disable(['B']);
    expect(b.nearestFree({ x: 10, y: 20, z: 0 }, 'd2')?.id).toBe('C');
    expect(b.nearestFree({ x: 10, y: 20, z: 0 }, 'd1')?.id).toBe('A'); // my own pad counts as free for me
  });

  it('disables pads for a window and restores them', () => {
    const pads = [pad('A', 0, 0), pad('B', 100, 0)];
    const b = new PadBook(pads);
    expect(b.disable(['A', 'nope'], 50)).toBe(1);
    expect(b.isEnabled('A')).toBe(false);
    expect(b.reserve('A', 'd1')).toBe(false);
    b.step(49);
    expect(b.disabledIds).toEqual(['A']);
    b.step(50);
    expect(b.disabledIds).toEqual([]);
    b.disable(['B']);
    b.step(1e9);
    expect(pads[1].enabled).toBe(false); // open-ended outages never expire
    b.reset();
    expect(pads.every((p) => p.enabled)).toBe(true);
  });
});

describe('public pads in the world', () => {
  const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 8 }, world: { public_pads: 3 } });
  const w = createWorld(worldConfigFrom(scn));
  const base = createWorld(worldConfigFrom(getScenario('test_small')));

  it('adds standalone pads with chargers outside the depots', () => {
    const pub = w.pads.filter((p) => p.depotId === '');
    expect(pub.length).toBeGreaterThan(0);
    expect(w.pads.length).toBe(base.pads.length + pub.length);
    for (const p of pub) {
      expect(w.chargers.some((c) => c.padId === p.id)).toBe(true);
      expect(inNoFly(w, p.pos.x, p.pos.z, 3, false)).toBe(false);
      expect(w.depots.some((d) => p.pos.x > d.apron.minX - 15 && p.pos.x < d.apron.maxX + 15 && p.pos.z > d.apron.minZ - 15 && p.pos.z < d.apron.maxZ + 15)).toBe(false);
      expect(w.dropPoints.some((d) => Math.hypot(d.pos.x - p.pos.x, d.pos.z - p.pos.z) < 3)).toBe(false);
    }
  });

  it('keeps depot pads, depots and the rest of the world as they were', () => {
    expect(w.depots.map((d) => d.pos)).toEqual(base.depots.map((d) => d.pos));
    expect(w.pads.filter((p) => p.depotId !== '').map((p) => p.pos)).toEqual(base.pads.map((p) => p.pos));
  });

  it('lets the fleet grow beyond the depot pads', () => {
    const eng = new SimulationEngine(w, scn);
    expect(eng.agents.length).toBeGreaterThan(base.pads.length - 1);
    expect(eng.agents.length).toBeLessThanOrEqual(w.pads.length);
    expect(new Set(eng.agents.map((a) => a.pad.id)).size).toBe(eng.agents.length);
  });
});

describe('pad outages in the engine', () => {
  const run = (scn: ReturnType<typeof scenarioWith>, seconds: number) => {
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * seconds; i++) eng.update(0.05);
    return eng;
  };

  it('moves a drone off a dead pad onto another working pad', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 3 }, world: { public_pads: 2 }, workload: { arrival_rate_per_min: 0.1 }, faults: [{ t: 5, type: 'depot_outage', id: 'D1', until: 900 }] });
    const eng = run(scn, 300);
    const fault = eng.events.find((e) => e.type === 'fault_depot_outage');
    expect(fault).toBeDefined();
    const moved = eng.agents.filter((a) => a.controller.padId !== a.controller.homePadId);
    expect(moved.length).toBeGreaterThanOrEqual(1);
    expect(eng.events.some((e) => e.type === 'pad_changed')).toBe(true);
    for (const a of eng.agents) expect(eng.pads.isEnabled(a.controller.padId)).toBe(true);
    const holders = eng.agents.map((a) => eng.pads.padOf(a.id)).filter((x): x is string => !!x);
    expect(new Set(holders).size).toBe(holders.length);
    const s = eng.snapshot();
    expect(s.padOutages.length).toBe(2);
    expect(s.collisions).toBe(0);
  });

  it('re-enables pads when the window ends and on reset', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 2 }, faults: [{ t: 5, type: 'pad_outage', id: 'PAD-D1-1', until: 60 }] });
    const eng = run(scn, 30);
    expect(eng.pads.isEnabled('PAD-D1-1')).toBe(false);
    for (let i = 0; i < 20 * 40; i++) eng.update(0.05);
    expect(eng.pads.isEnabled('PAD-D1-1')).toBe(true);
    const eng2 = run(scn, 30);
    eng2.reset();
    expect(eng2.pads.disabledIds).toEqual([]);
    expect(eng2.agents.length).toBe(2);
  });

  it('a drone with no free pad waits and says so once, without breaking', () => {
    // every depot pad out of service and no public pads: nobody can charge
    const scn = scenarioWith(getScenario('test_small'), {
      fleet: { n_drones: 3 },
      workload: { arrival_rate_per_min: 6 },
      faults: [{ t: 30, type: 'depot_outage', id: 'D1' }, { t: 30, type: 'depot_outage', id: 'D2' }, { t: 30, type: 'depot_outage', id: 'D3' }],
    });
    const eng = run(scn, 300);
    expect(eng.events.filter((e) => e.type === 'fault_depot_outage').length).toBe(3);
    const waits = eng.events.filter((e) => e.type === 'pad_unavailable');
    const perDrone = new Map<string, number>();
    for (const e of waits) perDrone.set(e.agent!, (perDrone.get(e.agent!) ?? 0) + 1);
    for (const n of perDrone.values()) expect(n).toBeLessThanOrEqual(2);
    expect(eng.snapshot().collisions).toBe(0);
  });

  it('is deterministic', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 4 }, world: { public_pads: 2 }, faults: [{ t: 40, type: 'depot_outage', id: 'D2', until: 200 }] });
    expect(run(scn, 240).eventHash()).toBe(run(scn, 240).eventHash());
  });

  it('ignores an outage for an unknown target and logs the failure', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 2 }, faults: [{ t: 5, type: 'pad_outage', id: 'PAD-NOPE' }] });
    const eng = run(scn, 20);
    expect(eng.events.some((e) => e.type === 'fault_pad_outage_failed')).toBe(true);
    expect(eng.pads.disabledIds).toEqual([]);
  });
});

describe('pad scarcity validation', () => {
  const find = (id: string) => findMap(id);
  it('requires an id for pad and depot outages and bounds public pads', () => {
    expect(() => loadScenario(parseScenarioYaml('faults: [{ t: 5, type: pad_outage }]', 'p.yaml'), 'p.yaml')).toThrow(/p\.yaml.*pad_outage.*id of a pad/);
    expect(() => loadScenario(parseScenarioYaml('faults: [{ t: 5, type: depot_outage }]', 'p2.yaml'), 'p2.yaml')).toThrow(/depot_outage.*id of a depot/);
    expect(() => loadScenario(parseScenarioYaml('map: flatland_rural\nworld: { public_pads: 20 }', 'p3.yaml'), 'p3.yaml', () => null, find)).toThrow(/public_pads/);
  });
});
