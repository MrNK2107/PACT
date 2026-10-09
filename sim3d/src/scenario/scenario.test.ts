import { describe, expect, it } from 'vitest';
import { createWorld, inNoFly } from '../world/buildWorld';
import { SCENARIO_DEFAULTS } from './defaults';
import { loadScenario, parseScenarioYaml, scenarioWith, worldConfigFrom } from './load';
import { DEFAULT_SCENARIO, SAMPLE_TASK_FILES, SCENARIOS, SCENARIO_NAMES } from './registry';

describe('scenario files', () => {
  it('loads every YAML under scenarios/ with PRD defaults applied', () => {
    expect(SCENARIO_NAMES.length).toBeGreaterThanOrEqual(6);
    expect(SCENARIOS[DEFAULT_SCENARIO]).toBeDefined();
    for (const n of SCENARIO_NAMES) {
      const s = SCENARIOS[n];
      expect(s.policy.lease_ttl_s).toBeGreaterThan(0);
      expect(s.workload.priority_mix.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(s.world.size_m[0]).toBe(s.world.size_m[1]);
      expect(s.fleet.max_drones).toBeGreaterThanOrEqual(s.fleet.n_drones);
    }
    expect(SCENARIOS.s0_healthy.fleet.n_drones).toBe(12);
    expect(SCENARIOS.s0_healthy.policy.partition).toBe('QUORUM');
    expect(SCENARIOS.s0_healthy.policy.t_commit_s).toBe(3);
  });

  it('resolves scripted task files and sorts faults by time', () => {
    expect(SAMPLE_TASK_FILES).toContain('tasks/demo_tasks.yaml');
    const demo = SCENARIOS.s_scripted_demo;
    expect(demo.workload.tasks_file).toBe('tasks/demo_tasks.yaml');
    expect(demo.workload.tasks.length).toBe(10);
    expect(demo.workload.tasks[0].task_id).toBe('D1:00000005:a001');
    const cz = SCENARIOS.s_close_zone;
    expect(cz.faults.map((f) => f.t)).toEqual([...cz.faults.map((f) => f.t)].sort((a, b) => a - b));
    expect(cz.faults[1].type).toBe('close_zone');
  });

  it('rejects invalid files with the path in the message', () => {
    expect(() => loadScenario(parseScenarioYaml('workload: { priority_mix: [0.5, 0.3, 0.3] }', 'bad.yaml'), 'bad.yaml')).toThrow(/bad\.yaml.*priority_mix/);
    expect(() => loadScenario(parseScenarioYaml('world: { size_m: [4000, 3000] }', 'rect.yaml'), 'rect.yaml')).toThrow(/square/);
    expect(() => loadScenario(parseScenarioYaml('world: { depots: 12 }', 'many.yaml'), 'many.yaml')).toThrow(/depots/);
    expect(() => loadScenario(parseScenarioYaml('workload: { tasks: tasks/missing.yaml }', 'ref.yaml'), 'ref.yaml')).toThrow(/missing\.yaml/);
  });

  it('maps PRD ground {x, y} onto world {x, z} and builds the world from the scenario', () => {
    const s = scenarioWith(SCENARIO_DEFAULTS, { world: { size_m: [2000, 2000], depots: 2, no_fly: ['auto', { id: 'NFZ-T', circle: { x: 300, y: -400, r: 50 } }, { id: 'NFZ-P', polygon: [{ x: -700, y: 100 }, { x: -600, y: 100 }, { x: -600, y: 200 }, { x: -700, y: 200 }] }] } });
    const cfg = worldConfigFrom(s);
    expect(cfg.size).toBe(2000);
    const circle = cfg.noFly.find((n) => n !== 'auto' && n.id === 'NFZ-T');
    expect(circle !== 'auto' && circle?.circle).toEqual({ x: 300, z: -400, r: 50 });
    const w = createWorld(cfg);
    expect(w.noFlyZones.some((z) => z.id === 'NFZ-T' && z.source === 'scenario')).toBe(true);
    expect(inNoFly(w, 300, -400)).toBe(true);
    expect(inNoFly(w, -650, 150)).toBe(true);
    expect(w.depots.length).toBe(2);
  });
});
