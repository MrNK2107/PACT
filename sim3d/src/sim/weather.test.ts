import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenarioYaml, scenarioWith, worldConfigFrom } from '../scenario/load';
import { loadMap } from '../map/load';
import { getScenario } from '../scenario/registry';
import { createWorld } from '../world/buildWorld';
import { blendWindParams, boostWind, generateWind, retargetWind, windAt } from '../world/Wind';
import type { NoFlyZone } from '../world/types';
import { ObstacleManager } from './ObstacleManager';
import { PathPlanner } from './PathPlanner';
import { SimulationEngine } from './SimulationEngine';

const world = createWorld(worldConfigFrom(getScenario('test_small')));
const cap = (minY: number, over: Partial<NoFlyZone> = {}): NoFlyZone => ({
  id: 'NFZ-CAP-T',
  name: 'ceiling',
  reason: 'test',
  shape: { type: 'box', minX: -1e5, maxX: 1e5, minZ: -1e5, maxZ: 1e5 },
  maxY: 10000,
  minY,
  closable: true,
  active: true,
  source: 'fault',
  ...over,
});

describe('wind field retargeting', () => {
  it('rebuilding with the same parameters reproduces the base field exactly', () => {
    const w = world.wind;
    const again = retargetWind(w, { mean_mps: w.mean, dir_deg: w.dirDeg, gust_mps: w.gust });
    expect(Array.from(again.vx.slice(0, 200))).toEqual(Array.from(w.vx.slice(0, 200)));
    expect(Array.from(again.vz.slice(0, 200))).toEqual(Array.from(w.vz.slice(0, 200)));
  });

  it('turns the mean wind when the direction changes and keeps the grid', () => {
    const w = world.wind;
    const east = retargetWind(w, { mean_mps: 10, dir_deg: 270, gust_mps: 0 }); // from the west: blows east (+x)
    const north = retargetWind(w, { mean_mps: 10, dir_deg: 180, gust_mps: 0 }); // from the south: blows north (-z)
    expect(east.nx).toBe(w.nx);
    const e = windAt(east, 0, 0);
    const n = windAt(north, 0, 0);
    expect(e.vx).toBeGreaterThan(8);
    expect(Math.abs(e.vz)).toBeLessThan(1.2);
    expect(n.vz).toBeLessThan(-8);
  });

  it('blends parameters linearly and takes the short way round the compass', () => {
    const a = { mean_mps: 2, dir_deg: 350, gust_mps: 1 };
    const b = { mean_mps: 10, dir_deg: 10, gust_mps: 3 };
    expect(blendWindParams(a, b, 0.5)).toEqual({ mean_mps: 6, dir_deg: 0, gust_mps: 2 });
    expect(blendWindParams(a, b, 1).dir_deg).toBeCloseTo(10, 9);
  });

  it('boosts a local area without touching the input or the far field', () => {
    const base = generateWind(1, { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000, minY: 0, maxY: 120 }, { mean_mps: 5, dir_deg: 270, gust_mps: 0 });
    const before = Array.from(base.vx);
    const boosted = boostWind(base, [{ x: 0, z: 0, r: 300, mps: 8 }]);
    expect(Array.from(base.vx)).toEqual(before);
    expect(Math.hypot(windAt(boosted, 0, 0).vx, windAt(boosted, 0, 0).vz)).toBeGreaterThan(Math.hypot(windAt(base, 0, 0).vx, windAt(base, 0, 0).vz) + 6);
    expect(windAt(boosted, 800, 800)).toEqual(windAt(base, 800, 800));
    expect(boostWind(base, [])).toBe(base);
  });
});

describe('altitude ceilings in the obstacle manager and planner', () => {
  it('tracks ceilings separately from horizontal closures', () => {
    const w = createWorld(worldConfigFrom(getScenario('test_small')));
    const om = new ObstacleManager(w);
    const v0 = om.capVersion;
    om.addZone(cap(40));
    expect(om.capVersion).toBe(v0 + 1);
    expect(om.ceilingAt(10, 10)).toBe(40);
    expect(om.inActiveNoFly(10, 10)).toBe(false); // a ceiling is not a horizontal closure
    om.setZoneActive('NFZ-CAP-T', false);
    expect(om.ceilingAt(10, 10)).toBe(Infinity);
    expect(om.capVersion).toBe(v0 + 2);
  });

  it('plans under the ceiling and fails when no layer is left', () => {
    const w = createWorld(worldConfigFrom(getScenario('test_small')));
    const from = { x: w.depots[0].handoff[0].x, y: w.depots[0].handoff[0].y, z: w.depots[0].handoff[0].z };
    const to = w.depots[1].handoff[0];
    const free = new PathPlanner(new ObstacleManager(w), w.bounds).plan(from, to, 28);
    expect(free).not.toBeNull();

    const omHigh = new ObstacleManager(w);
    omHigh.addZone(cap(40));
    const underHigh = new PathPlanner(omHigh, w.bounds).plan(from, to, 28);
    expect(underHigh).not.toBeNull();
    expect(underHigh!.cruiseAlt).toBeLessThan(40);

    const omLow = new ObstacleManager(w);
    omLow.addZone(cap(20));
    expect(new PathPlanner(omLow, w.bounds).plan(from, to, 28)).toBeNull();
  });
});

describe('weather faults in the engine', () => {
  const run = (scn: ReturnType<typeof scenarioWith>, seconds: number, each?: (eng: SimulationEngine) => void) => {
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * seconds; i++) {
      eng.update(0.05);
      each?.(eng);
    }
    return eng;
  };

  it('a weather front ramps the wind, then returns to the base wind at `until`', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 2 }, faults: [{ t: 10, type: 'weather_front', mean_mps: 12, dir_deg: 90, ramp_s: 20, until: 100 }] });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    const base = eng.windNow.mean_mps;
    const baseField = eng.world.wind;
    eng.start();
    const at = (t: number) => {
      while (eng.time < t) eng.update(0.05);
    };
    at(21);
    expect(eng.windNow.mean_mps).toBeGreaterThan(base);
    expect(eng.windNow.mean_mps).toBeLessThan(12);
    at(41);
    expect(eng.windNow.mean_mps).toBeCloseTo(12, 6);
    expect(eng.windNow.dir_deg).toBeCloseTo(90, 6);
    expect(eng.world.wind.mean).toBeCloseTo(12, 6);
    at(141);
    expect(eng.windNow.mean_mps).toBeCloseTo(base, 6);
    expect(eng.windVersion).toBeGreaterThan(2);
    expect(eng.events.some((e) => e.type === 'fault_weather_front')).toBe(true);
    eng.reset();
    expect(eng.world.wind).toBe(baseField);
    expect(eng.windNow.mean_mps).toBe(base);
  });

  it('runs without weather never rebuild the wind field', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 3 } });
    const eng = run(scn, 120);
    expect(eng.windVersion).toBe(1); // only the initial reset epoch
  });

  it('a storm cell closes airspace, drifts in 30 s steps, boosts the wind, and ends', () => {
    const scn = scenarioWith(getScenario('test_small'), {
      fleet: { n_drones: 2 },
      faults: [{ t: 10, type: 'storm_cell', circle: { x: -400, y: 0, r: 150 }, to: { x: 400, y: 0 }, duration_s: 200, wind_mps: 9, until: 220 }],
    });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    const at = (t: number) => {
      while (eng.time < t) eng.update(0.05);
    };
    const baseSpeed = Math.hypot(windAt(eng.world.wind, -400, 0).vx, windAt(eng.world.wind, -400, 0).vz);
    at(12);
    const z = eng.obstacles.allNoFly.find((q) => q.id === 'NFZ-STORM-1')!;
    expect(z.active).toBe(true);
    expect(z.shape).toMatchObject({ type: 'circle', x: -400 });
    expect(Math.hypot(windAt(eng.world.wind, -400, 0).vx, windAt(eng.world.wind, -400, 0).vz)).toBeGreaterThan(baseSpeed + 5);
    const zv = eng.obstacles.zoneVersion;
    at(25);
    expect(eng.obstacles.zoneVersion).toBe(zv); // no re-anchor before 30 s
    at(60);
    expect(eng.obstacles.zoneVersion).toBeGreaterThan(zv);
    const moved = z.shape as { x: number };
    expect(moved.x).toBeGreaterThan(-400);
    expect(moved.x).toBeLessThan(400);
    at(230);
    expect(z.active).toBe(false);
    expect(Math.hypot(windAt(eng.world.wind, -400, 0).vx, windAt(eng.world.wind, -400, 0).vz)).toBeCloseTo(baseSpeed, 3);
    eng.reset();
    expect(eng.obstacles.allNoFly.some((q) => q.id.startsWith('NFZ-STORM'))).toBe(false);
  });

  it('an altitude cap replans airborne drones under the ceiling and delivers on', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 5 }, faults: [{ t: 40, type: 'altitude_cap', cap_m: 40, until: 400 }] });
    let worst = 0;
    let delivered0 = -1;
    const eng = run(scn, 300, (e) => {
      if (e.time < 75) return;
      if (delivered0 < 0) delivered0 = e.snapshot().completed;
      for (const a of e.agents) if (a.airborne) worst = Math.max(worst, a.body.pos.y);
    });
    expect(eng.events.some((e) => e.type === 'fault_altitude_cap')).toBe(true);
    expect(eng.events.some((e) => e.type === 'replanned' && (e.data as { detail?: string }).detail === 'altitude ceiling')).toBe(true);
    expect(worst).toBeLessThan(43);
    const s = eng.snapshot();
    expect(s.completed).toBeGreaterThan(delivered0);
    expect(s.collisions).toBe(0);
    expect(s.closedZones.some((z) => z.startsWith('NFZ-CAP'))).toBe(true);
  });

  it('drones on high cruise layers still plan under a low ceiling and none runs dry', () => {
    // layers are 28 / 37 / 46 / 55 m: with a 35 m ceiling three of four layers are closed
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 6 }, faults: [{ t: 30, type: 'altitude_cap', cap_m: 35 }] });
    let before = -1;
    const eng = run(scn, 400, (e) => {
      if (before < 0 && e.time >= 40) before = e.snapshot().completed;
    });
    expect(eng.events.filter((e) => e.type === 'battery_depleted')).toHaveLength(0);
    expect(eng.snapshot().completed).toBeGreaterThan(before + 3);
    // nobody sits in a task phase without a task (a dropped task must not hold the pickup site)
    for (const a of eng.agents) if (a.controller.phase === 'loading' || a.controller.phase === 'unloading') expect(a.controller.taskId).not.toBeNull();
  });

  it('a weather scenario is deterministic', () => {
    const scn = scenarioWith(getScenario('test_small'), {
      fleet: { n_drones: 4 },
      faults: [
        { t: 20, type: 'weather_front', mean_mps: 10, dir_deg: 45, ramp_s: 30 },
        { t: 40, type: 'storm_cell', circle: { x: 0, y: 0, r: 200 }, to: { x: 300, y: 100 }, wind_mps: 6, until: 200 },
        { t: 60, type: 'altitude_cap', cap_m: 50, until: 180 },
      ],
    });
    expect(run(scn, 240).eventHash()).toBe(run(scn, 240).eventHash());
  });
});

describe('weather fault validation', () => {
  it('rejects malformed weather faults with the path in the message', () => {
    const bad = (yaml: string, re: RegExp) => expect(() => loadScenario(parseScenarioYaml(yaml, 'w.yaml'), 'w.yaml')).toThrow(re);
    bad('faults: [{ t: 5, type: weather_front }]', /w\.yaml.*weather_front.*mean_mps, dir_deg or gust_mps/);
    bad('faults: [{ t: 5, type: weather_front, mean_mps: 99 }]', /mean_mps/);
    bad('faults: [{ t: 5, type: storm_cell }]', /storm_cell.*circle/);
    bad('faults: [{ t: 5, type: storm_cell, circle: { x: 0, y: 0, r: 0 } }]', /circle/);
    bad('faults: [{ t: 5, type: altitude_cap, cap_m: 3 }]', /cap_m/);
  });

  it('merges a map weather schedule into its scenarios', () => {
    const map = loadMap('id: windy\nsize_m: 3000\nmechanics: { weather: [{ t: 100, type: weather_front, mean_mps: 9 }] }', 'windy.yaml');
    expect(map.mechanics.weather).toHaveLength(1);
    const s = loadScenario(parseScenarioYaml('map: windy\nfaults: [{ t: 50, type: close_zone, id: stadium }]', 's.yaml'), 's.yaml', () => null, (id) => (id === 'windy' ? map : null));
    expect(s.faults.map((f) => f.type)).toEqual(['close_zone', 'weather_front']);
    expect(() => loadMap('id: bad\nmechanics: { weather: [{ t: 1, type: earthquake }] }', 'bad.yaml')).toThrow(/mechanics\.weather\[0\]/);
  });
});
