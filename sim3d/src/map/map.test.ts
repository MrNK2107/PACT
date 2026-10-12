import { describe, expect, it } from 'vitest';
import { loadScenario, parseScenarioYaml } from '../scenario/load';
import { SCENARIOS, SCENARIO_NAMES, resolveSelection, scenariosForMap, tierOf } from '../scenario/registry';
import { loadMap } from './load';
import { DEFAULT_MAP, MAPS, MAP_IDS, VISIBLE_MAP_IDS, findMap } from './registry';

describe('map files', () => {
  it('loads the legacy maps with validated fields', () => {
    expect(MAP_IDS).toEqual(expect.arrayContaining(['coastal_metro', 'harbour_metro_xl', 'coastal_testbed']));
    expect(MAPS.coastal_metro.size_m).toBe(4000);
    expect(MAPS.harbour_metro_xl.size_m).toBe(12000);
    expect(MAPS.harbour_metro_xl.logistics.depots.count).toBe(8);
    expect(VISIBLE_MAP_IDS).not.toContain('coastal_testbed');
    expect(MAPS[DEFAULT_MAP]).toBeDefined();
  });

  it('rejects invalid map files with the path in the message', () => {
    expect(() => loadMap('size_m: 100', 'tiny.yaml')).toThrow(/tiny\.yaml.*size_m/);
    expect(() => loadMap('tier: easy', 'tier.yaml')).toThrow(/tier\.yaml.*tier/);
    expect(() => loadMap('geography: { water: lava }', 'water.yaml')).toThrow(/water/);
    expect(() => loadMap('logistics: { depots: { pads: 5 } }', 'pads.yaml')).toThrow(/pads/);
    expect(() => loadMap('id: Bad-Id', 'id.yaml')).toThrow(/id/);
  });

  it('allows up to 6 pads only for a single hub', () => {
    expect(loadMap('logistics: { depots: { layout: single_hub, count: 1, pads: 6 } }', 'hub.yaml').logistics.depots.pads).toBe(6);
  });
});

describe('scenario to map binding', () => {
  it('every scenario names a known map and inherits its size', () => {
    for (const n of SCENARIO_NAMES) {
      const s = SCENARIOS[n];
      const m = findMap(s.map);
      expect(m, `${n} -> ${s.map}`).not.toBeNull();
      expect(s.world.size_m).toEqual([m!.size_m, m!.size_m]);
    }
    expect(SCENARIOS.test_small.map).toBe('coastal_testbed');
    expect(SCENARIOS.s10_scale.map).toBe('harbour_metro_xl');
  });

  it('every curated scenario in a map file exists and belongs to it', () => {
    for (const m of Object.values(MAPS)) {
      for (const n of m.scenarios) {
        expect(SCENARIOS[n], `${m.id} lists ${n}`).toBeDefined();
        expect(SCENARIOS[n].map).toBe(m.id);
      }
    }
  });

  it('orders a map picker by the curated list, then alphabetically', () => {
    expect(scenariosForMap('coastal_metro').map((s) => s.name)).toEqual(['s0_healthy', 's6_battery_crunch', 's7_urgent_burst', 's_close_zone', 's_scripted_demo']);
  });

  it('rejects an unknown map and a size that conflicts with the map', () => {
    const find = (id: string) => findMap(id);
    expect(() => loadScenario(parseScenarioYaml('map: nowhere', 'a.yaml'), 'a.yaml', () => null, find)).toThrow(/a\.yaml.*unknown map "nowhere"/);
    expect(() => loadScenario(parseScenarioYaml('map: coastal_metro\nworld: { size_m: [2000, 2000] }', 'b.yaml'), 'b.yaml', () => null, find)).toThrow(/b\.yaml.*size belongs to the map/);
  });

  it('applies map defaults under scenario overrides and keeps the scenario seed', () => {
    const s = loadScenario(parseScenarioYaml('map: harbour_metro_xl\nseed: 5\nworld: { depots: 4 }', 'c.yaml'), 'c.yaml', () => null, (id) => findMap(id));
    expect(s.world.size_m).toEqual([12000, 12000]);
    expect(s.world.depots).toBe(4);
    expect(s.world.pads_per_depot).toBe(3);
    expect(s.world.wind.mean_mps).toBe(5);
    expect(s.seed).toBe(5);
  });

  it('inherits the tier from the map unless the scenario sets one', () => {
    expect(tierOf(SCENARIOS.s10_scale)).toBe('stress');
    const s = loadScenario(parseScenarioYaml('map: coastal_metro\ntier: hard', 'd.yaml'), 'd.yaml', () => null, (id) => findMap(id));
    expect(tierOf(s)).toBe('hard');
    expect(() => loadScenario(parseScenarioYaml('tier: easy', 'e.yaml'), 'e.yaml')).toThrow(/tier/);
  });
});

describe('URL selection', () => {
  it('derives the map from a scenario, and the scenario from a map', () => {
    expect(resolveSelection(null, 's10_scale').map.id).toBe('harbour_metro_xl');
    expect(resolveSelection('harbour_metro_xl', null).scenario.name).toBe('s10_scale');
    expect(resolveSelection('coastal_metro', 's0_healthy').scenario.name).toBe('s0_healthy');
  });

  it('falls back to the requested map\'s first scenario when the scenario belongs elsewhere', () => {
    const r = resolveSelection('coastal_metro', 's10_scale');
    expect(r.map.id).toBe('coastal_metro');
    expect(r.scenario.name).toBe('s0_healthy');
  });

  it('falls back to the default scenario for unknown names', () => {
    const r = resolveSelection('nope', 'nope');
    expect(r.scenario.name).toBe('s0_healthy');
    expect(r.map.id).toBe('coastal_metro');
  });
});
