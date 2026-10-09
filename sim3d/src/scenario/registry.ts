import { loadScenario, parseScenarioYaml, parseTasksYaml } from './load';
import type { Scenario, ScriptedTaskSpec } from './types';

/**
 * Every YAML under sim3d/scenarios/ is bundled (Vite `import.meta.glob` with `?raw`), parsed and
 * validated at start-up. Task files under scenarios/tasks/ are referenced by `workload.tasks`.
 */
const scenarioFiles = import.meta.glob('../../scenarios/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const taskFiles = import.meta.glob('../../scenarios/tasks/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const tasksByRef = new Map<string, ScriptedTaskSpec[]>();
for (const [path, text] of Object.entries(taskFiles)) {
  const ref = path.replace(/^.*scenarios\//, '');
  tasksByRef.set(ref, parseTasksYaml(text, ref));
}

export const SCENARIOS: Record<string, Scenario> = {};
for (const [path, text] of Object.entries(scenarioFiles)) {
  const file = path.replace(/^.*\//, '');
  const s = loadScenario(parseScenarioYaml(text, file), file, (ref) => tasksByRef.get(ref) ?? tasksByRef.get(ref.replace(/^\.\//, '')) ?? null);
  SCENARIOS[s.name] = s;
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS).sort();
export const DEFAULT_SCENARIO = 's0_healthy';

export function getScenario(name: string | null | undefined): Scenario {
  if (name && SCENARIOS[name]) return SCENARIOS[name];
  return SCENARIOS[DEFAULT_SCENARIO] ?? SCENARIOS[SCENARIO_NAMES[0]];
}

export const SAMPLE_TASK_FILES = [...tasksByRef.keys()].sort();
