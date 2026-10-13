import { DEFAULT_MAP, MAPS, VISIBLE_MAP_IDS, findMap, getMap } from '../map/registry';
import type { MapDef } from '../map/types';
import { loadScenario, parseScenarioYaml, parseTasksYaml } from './load';
import type { Scenario, ScriptedTaskSpec } from './types';

/**
 * Every YAML under sim3d/scenarios/ (any depth, except scenarios/tasks/) is bundled (Vite `import.meta.glob`
 * with `?raw`), parsed and validated at start-up. Scenarios live in a folder per map by convention; the
 * binding that counts is the `map:` field. Task files under scenarios/tasks/ are referenced by `workload.tasks`.
 */
const scenarioFiles = import.meta.glob(['../../scenarios/**/*.yaml', '!../../scenarios/tasks/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const taskFiles = import.meta.glob('../../scenarios/tasks/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const tasksByRef = new Map<string, ScriptedTaskSpec[]>();
for (const [path, text] of Object.entries(taskFiles)) {
  const ref = path.replace(/^.*scenarios\//, '');
  tasksByRef.set(ref, parseTasksYaml(text, ref));
}

export const SCENARIOS: Record<string, Scenario> = {};
for (const [path, text] of Object.entries(scenarioFiles)) {
  const file = path.replace(/^.*scenarios\//, '');
  const s = loadScenario(parseScenarioYaml(text, file), file, (ref) => tasksByRef.get(ref) ?? tasksByRef.get(ref.replace(/^\.\//, '')) ?? null, findMap);
  if (SCENARIOS[s.name]) throw new Error(`scenario ${file}: duplicate scenario name "${s.name}"`);
  SCENARIOS[s.name] = s;
}

export const SCENARIO_NAMES = Object.keys(SCENARIOS).sort();
export const DEFAULT_SCENARIO = 's0_healthy';

export function getScenario(name: string | null | undefined): Scenario {
  if (name && SCENARIOS[name]) return SCENARIOS[name];
  return SCENARIOS[DEFAULT_SCENARIO] ?? SCENARIOS[SCENARIO_NAMES[0]];
}

/** A map's scenarios: the curated `scenarios:` list first (in order), then the rest alphabetically. */
export function scenariosForMap(mapId: string): Scenario[] {
  const all = SCENARIO_NAMES.map((n) => SCENARIOS[n]).filter((s) => s.map === mapId);
  const curated = (MAPS[mapId]?.scenarios ?? []).map((n) => all.find((s) => s.name === n)).filter((s): s is Scenario => !!s);
  return [...curated, ...all.filter((s) => !curated.includes(s))];
}

/** The scenario's difficulty tier: its own, else the map's. */
export function tierOf(s: Scenario): string {
  return s.tier ?? getMap(s.map).tier;
}

/**
 * Resolves the `?map=` / `?scenario=` URL parameters to a (map, scenario) pair.
 *  - only a scenario: its own map
 *  - only a map: the map's first scenario
 *  - both, but the scenario belongs to another map: the requested map's first scenario
 *  - neither / unknown: the default scenario and its map
 */
export function resolveSelection(mapParam: string | null | undefined, scenarioParam: string | null | undefined): { map: MapDef; scenario: Scenario } {
  const requestedMap = mapParam ? findMap(mapParam) : null;
  const requestedScenario = scenarioParam && SCENARIOS[scenarioParam] ? SCENARIOS[scenarioParam] : null;
  if (requestedMap) {
    if (requestedScenario && requestedScenario.map === requestedMap.id) return { map: requestedMap, scenario: requestedScenario };
    const first = scenariosForMap(requestedMap.id)[0];
    if (first) return { map: requestedMap, scenario: first };
  }
  const scenario = requestedScenario ?? getScenario(null);
  return { map: getMap(scenario.map), scenario };
}

export { DEFAULT_MAP, VISIBLE_MAP_IDS };
export const SAMPLE_TASK_FILES = [...tasksByRef.keys()].sort();
