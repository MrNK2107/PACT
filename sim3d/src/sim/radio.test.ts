import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenarioYaml, scenarioWith, worldConfigFrom } from '../scenario/load';
import { findMap } from '../map/registry';
import { getScenario } from '../scenario/registry';
import { createWorld } from '../world/buildWorld';
import { radioEffectAt, radioSpecsFrom, radioZoneFromSpec } from '../world/Radio';
import { Rng } from '../world/rng';
import type { RadioZone, Vec3 } from '../world/types';
import { MessageBus } from './AgentCoordinator';
import { SIM } from './config';
import { RadioModel } from './Radio';
import { SimulationEngine } from './SimulationEngine';
import type { Message } from './types';

const zone = (over: Partial<RadioZone> = {}): RadioZone => ({
  id: 'RAD-T',
  name: 'test zone',
  shape: { type: 'circle', x: 0, z: 0, r: 100 },
  rangeFactor: 0,
  lossAdd: 0,
  maxY: 70,
  active: true,
  source: 'scenario',
  ...over,
});
const at = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

describe('radio effect geometry', () => {
  it('applies inside an active zone below its ceiling only', () => {
    const z = [zone({ rangeFactor: 0.25, lossAdd: 0.3 })];
    const inside = radioEffectAt(z, 10, 30, 10);
    expect(inside.rangeFactor).toBe(0.25);
    expect(inside.loss).toBeCloseTo(0.3, 9);
    expect(radioEffectAt(z, 500, 30, 0)).toEqual({ rangeFactor: 1, loss: 0 });
    expect(radioEffectAt(z, 10, 90, 10)).toEqual({ rangeFactor: 1, loss: 0 });
    expect(radioEffectAt([zone({ active: false })], 10, 30, 10).rangeFactor).toBe(1);
  });

  it('combines overlapping zones: smallest range factor, losses combined', () => {
    const e = radioEffectAt([zone({ rangeFactor: 0.5, lossAdd: 0.2 }), zone({ id: 'B', rangeFactor: 0.3, lossAdd: 0.5 })], 0, 20, 0);
    expect(e.rangeFactor).toBe(0.3);
    expect(e.loss).toBeCloseTo(1 - 0.8 * 0.5, 9);
  });

  it('maps file coordinates (y -> z) and builds zones from specs', () => {
    const [spec] = radioSpecsFrom([{ id: 'R1', circle: { x: 10, y: -20, r: 30 }, range_factor: 0.1, loss: 0.2, max_alt_m: 55 }]);
    expect(spec.circle).toEqual({ x: 10, z: -20, r: 30 });
    const z = radioZoneFromSpec(spec, 0);
    expect(z).toMatchObject({ id: 'R1', rangeFactor: 0.1, lossAdd: 0.2, maxY: 55, active: true });
    expect(() => radioZoneFromSpec({}, 0)).toThrow(/circle, box or polygon/);
  });
});

describe('radio in the message bus', () => {
  const hb = (from: string, pos: Vec3): Message => ({ type: 'HEARTBEAT', from, pos, vel: at(0, 0, 0), intent: at(0, 0, 0), priority: 1, phase: 'idle', site: null, stage: null }) as Message;
  const run = (radio: RadioModel | undefined, agents: { id: string; pos: Vec3 }[], senders: string[]) => {
    const bus = new MessageBus();
    for (const s of senders) bus.broadcast(s, agents.find((a) => a.id === s)!.pos, hb(s, agents.find((a) => a.id === s)!.pos));
    bus.deliver(agents, new Rng(1), radio);
    return Object.fromEntries(agents.map((a) => [a.id, bus.take(a.id).length]));
  };

  it('drops every link with an endpoint inside a dark zone and keeps links outside it', () => {
    SIM.packetLoss = 0;
    SIM.commRange = 1500;
    const radio = new RadioModel([zone()]);
    const agents = [
      { id: 'IN1', pos: at(10, 30, 10) },
      { id: 'IN2', pos: at(20, 30, 20) },
      { id: 'OUT1', pos: at(300, 30, 0) },
      { id: 'OUT2', pos: at(320, 30, 40) },
    ];
    // sender inside: nobody hears it (dark endpoint)
    expect(run(radio, agents, ['IN1'])).toEqual({ IN1: 0, IN2: 0, OUT1: 0, OUT2: 0 });
    // sender outside: the dark receivers hear nothing, the other outside agent does
    expect(run(radio, agents, ['OUT1'])).toEqual({ IN1: 0, IN2: 0, OUT1: 0, OUT2: 1 });
    // without a radio model the plain disc model delivers to everyone in range
    expect(run(undefined, agents, ['IN1'])).toEqual({ IN1: 0, IN2: 1, OUT1: 1, OUT2: 1 });
  });

  it('shrinks the range for partially degraded zones', () => {
    SIM.packetLoss = 0;
    SIM.commRange = 1000;
    const radio = new RadioModel([zone({ rangeFactor: 0.1 })]);
    const agents = [
      { id: 'IN', pos: at(0, 30, 0) },
      { id: 'NEAR', pos: at(80, 30, 0) },
      { id: 'FAR', pos: at(400, 30, 0) },
    ];
    expect(run(radio, agents, ['IN'])).toEqual({ IN: 0, NEAR: 1, FAR: 0 });
  });

  it('a clear model changes nothing, including the loss draws', () => {
    SIM.packetLoss = 0.3;
    SIM.commRange = 1500;
    const agents = [
      { id: 'A', pos: at(0, 30, 0) },
      { id: 'B', pos: at(50, 30, 0) },
    ];
    const a = Array.from({ length: 40 }, () => run(undefined, agents, ['A']).B);
    const b = Array.from({ length: 40 }, () => run(new RadioModel([zone({ shape: { type: 'circle', x: 9000, z: 9000, r: 10 } })]), agents, ['A']).B);
    expect(b).toEqual(a);
  });
});

describe('radio model state', () => {
  it('activates for a window, expires, and resets fault zones', () => {
    const z = zone({ id: 'RAD-W', active: false });
    const radio = new RadioModel([z]);
    expect(radio.setActive('RAD-W', true, 10, 40)).toBe(true);
    expect(radioEffectAt(radio.zones, 0, 20, 0).rangeFactor).toBe(0);
    radio.step(39);
    expect(z.active).toBe(true);
    radio.step(40);
    expect(z.active).toBe(false);
    expect(radio.setActive('nope', true)).toBe(false);
    radio.add(zone({ id: 'RAD-FAULT-1', source: 'fault' }));
    radio.reset();
    expect(radio.zones.map((q) => q.id)).toEqual(['RAD-W']);
  });
});

describe('radio zones in the world and engine', () => {
  it('generates urban canyon shadows on the dense map and none on legacy maps', () => {
    const dm = createWorld(worldConfigFrom(getScenario('dm_healthy')));
    expect(dm.radioZones.length).toBeGreaterThan(0);
    expect(dm.radioZones.every((r) => r.source === 'auto' && r.rangeFactor < 1)).toBe(true);
    expect(createWorld(worldConfigFrom(getScenario('test_small'))).radioZones).toEqual([]);
    const again = createWorld(worldConfigFrom(getScenario('dm_healthy')));
    expect(again.radioZones).toEqual(dm.radioZones);
  });

  it('radio_blackout creates a zone, ends at `until`, and reset removes it', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 3 }, faults: [{ t: 10, type: 'radio_blackout', name: 'Cordon', circle: { x: 0, y: 0, r: 200 }, until: 60 }] });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * 30; i++) eng.update(0.05);
    expect(eng.radio.zones.some((z) => z.source === 'fault' && z.active)).toBe(true);
    expect(eng.events.some((e) => e.type === 'fault_radio_blackout')).toBe(true);
    for (let i = 0; i < 20 * 40; i++) eng.update(0.05);
    expect(eng.radio.zones.find((z) => z.source === 'fault')!.active).toBe(false);
    eng.reset();
    expect(eng.radio.zones.some((z) => z.source === 'fault')).toBe(false);
  });

  it('radio_blackout can switch an existing zone on by id', () => {
    const scn = scenarioWith(getScenario('dm_healthy'), { faults: [{ t: 5, type: 'radio_blackout', id: 'RAD-01', range_factor: 0, until: 100 }] });
    const w = createWorld(worldConfigFrom(scn));
    const eng = new SimulationEngine(w, scn);
    eng.start();
    for (let i = 0; i < 20 * 10; i++) eng.update(0.05);
    expect(eng.radio.zones.find((z) => z.id === 'RAD-01')!.closedUntil).toBe(100);
    expect(eng.events.some((e) => e.type === 'fault_radio_blackout')).toBe(true);
  });

  it('a degraded-radio run is deterministic', () => {
    const scn = getScenario('dm_canyon_shadow');
    const run = () => {
      const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
      eng.start();
      for (let i = 0; i < 20 * 240; i++) eng.update(0.05);
      return eng.eventHash();
    };
    expect(run()).toBe(run());
  });
});

describe('separation without a radio (invariant I4)', () => {
  it('drones keep apart when the whole map is a radio dead zone', () => {
    // every link is dark: heartbeats never arrive, so only on-board sensing can keep the drones apart
    const dark = { id: 'RAD-ALL', circle: { x: 0, y: 0, r: 5000 }, range_factor: 0, max_alt_m: 200 };
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 6 }, workload: { arrival_rate_per_min: 6 }, world: { radio_zones: [dark] } });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    expect(eng.radio.zones).toHaveLength(1);
    eng.start();
    let heard = 0;
    for (let i = 0; i < 20 * 400; i++) {
      eng.update(0.05);
      if (i % 20 === 0) for (const a of eng.agents) heard += a.controller.neighborCount;
    }
    const s = eng.snapshot();
    expect(heard).toBe(0); // nobody heard a heartbeat
    expect(s.collisions).toBe(0);
    expect(s.completed).toBeGreaterThan(5);
  });

  it('sensed drones are added as neighbours with my own priority, so the id tie-break is symmetric', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 2 } });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    const [a, b] = eng.agents;
    b.body.pos.x = a.body.pos.x + 20;
    b.body.pos.y = a.body.pos.y + 5;
    b.body.pos.z = a.body.pos.z;
    eng.start();
    eng.update(0.05);
    // within 45 m but nothing has been heard yet: the controller still lists the other drone
    expect(a.controller.neighbors.map((n) => n.id)).toContain(b.id);
    expect(b.controller.neighbors.map((n) => n.id)).toContain(a.id);
    const na = a.controller.neighbors.find((n) => n.id === b.id)!;
    expect(na.priority).toBe(a.controller.priority);
  });
});

describe('radio zone validation', () => {
  const find = (id: string) => findMap(id);
  it('rejects a zone without a shape and out-of-range values', () => {
    expect(() => loadScenario(parseScenarioYaml('map: dense_metro_core\nworld: { radio_zones: [{ id: X }] }', 'r.yaml'), 'r.yaml', () => null, find)).toThrow(/r\.yaml.*circle, box or polygon/);
    expect(() => loadScenario(parseScenarioYaml('map: dense_metro_core\nworld: { radio_zones: [{ circle: { x: 0, y: 0, r: 5 }, range_factor: 2 }] }', 'r2.yaml'), 'r2.yaml', () => null, find)).toThrow(/range_factor/);
    expect(() => loadScenario(parseScenarioYaml('faults: [{ t: 5, type: radio_blackout }]', 'r3.yaml'), 'r3.yaml')).toThrow(/radio_blackout|faults\[0\]/);
  });

  it('adds scenario radio zones on top of the map zones', () => {
    const s = loadScenario(parseScenarioYaml('map: flatland_rural\nworld: { radio_zones: [{ id: RAD-X, circle: { x: 100, y: 200, r: 50 }, range_factor: 0.2 }] }', 'r4.yaml'), 'r4.yaml', () => null, find);
    const w = createWorld(worldConfigFrom(s));
    expect(w.radioZones.map((z) => z.id)).toEqual(['RAD-X']);
    expect(w.radioZones[0].shape).toEqual({ type: 'circle', x: 100, z: 200, r: 50 });
  });
});
