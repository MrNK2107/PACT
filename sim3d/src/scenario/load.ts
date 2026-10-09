import { parse } from 'yaml';
import type { NoFlySpec, WorldGenConfig } from '../world/types';
import { SCENARIO_DEFAULTS } from './defaults';
import type { DeepPartial, FaultDef, Scenario, ScriptedTaskSpec } from './types';

/**
 * Parses and validates a scenario file. Missing fields take PRD defaults; invalid files fail with
 * the file path in the message so a bad experiment config is never silently "fixed".
 */

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function merge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? merge(b, v) : v;
  }
  return out as T;
}

function fail(path: string, msg: string): never {
  throw new Error(`scenario ${path}: ${msg}`);
}

function num(path: string, v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) fail(path, `${name} must be a number in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
  return v;
}

export function parseScenarioYaml(text: string, path: string): DeepPartial<Scenario> {
  const raw = parse(text) as unknown;
  if (!isObj(raw)) fail(path, 'top level must be a mapping');
  return raw as DeepPartial<Scenario>;
}

export function parseTasksYaml(text: string, path: string): ScriptedTaskSpec[] {
  const raw = parse(text) as unknown;
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.tasks) ? raw.tasks : null;
  if (!list) fail(path, 'task file must be a list (or a mapping with a `tasks` list)');
  return list.map((t, i) => {
    if (!isObj(t)) fail(path, `tasks[${i}] must be a mapping`);
    num(path, t.t, `tasks[${i}].t`, 0, 1e7);
    if (t.priority !== undefined && ![1, 2, 3].includes(t.priority as number)) fail(path, `tasks[${i}].priority must be 1, 2 or 3`);
    if (!t.drop_id && !isObj(t.drop) && typeof t.cluster_type !== 'string') fail(path, `tasks[${i}] needs drop_id, drop {x, y} or cluster_type`);
    return t as unknown as ScriptedTaskSpec;
  });
}

/**
 * Builds a validated Scenario from parsed file contents. `resolveTasks` returns the scripted task list
 * for a `workload.tasks` file reference (relative to scenarios/).
 */
export function loadScenario(raw: DeepPartial<Scenario>, path: string, resolveTasks: (ref: string) => ScriptedTaskSpec[] | null = () => null): Scenario {
  const rawTasks = (raw.workload as { tasks?: unknown } | undefined)?.tasks;
  const over = { ...raw, workload: raw.workload ? { ...raw.workload, tasks: undefined } : undefined };
  const s = merge(SCENARIO_DEFAULTS, over);
  s.name = typeof raw.name === 'string' && raw.name ? raw.name : path.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/, '');
  num(path, s.seed, 'seed', 0, 2 ** 31);
  num(path, s.duration_s, 'duration_s', 1, 1e7);
  const f = s.fleet;
  num(path, f.n_drones, 'fleet.n_drones', 1, 50);
  num(path, f.capacity_kg, 'fleet.capacity_kg', 0.1, 50);
  num(path, f.speed_mps, 'fleet.speed_mps', 1, 40);
  num(path, f.battery_wh, 'fleet.battery_wh', 10, 5000);
  num(path, f.max_drones, 'fleet.max_drones', f.n_drones, 50);
  const w = s.world;
  if (!Array.isArray(w.size_m) || w.size_m.length !== 2) fail(path, 'world.size_m must be [w, h]');
  num(path, w.size_m[0], 'world.size_m[0]', 1500, 20000);
  if (w.size_m[0] !== w.size_m[1]) fail(path, `world.size_m must be square (got ${w.size_m[0]} x ${w.size_m[1]}); non-square maps are not supported`);
  num(path, w.depots, 'world.depots', 1, 8);
  num(path, w.pads_per_depot, 'world.pads_per_depot', 1, 3);
  num(path, w.drop_points_per_km2, 'world.drop_points_per_km2', 1, 200);
  num(path, w.wind.mean_mps, 'world.wind.mean_mps', 0, 30);
  if (!Array.isArray(w.no_fly)) fail(path, 'world.no_fly must be a list');
  const wl = s.workload;
  num(path, wl.arrival_rate_per_min, 'workload.arrival_rate_per_min', 0, 600);
  if (!Array.isArray(wl.priority_mix) || wl.priority_mix.length !== 3) fail(path, 'workload.priority_mix must have 3 entries');
  const sum = wl.priority_mix.reduce((a, b) => a + num(path, b, 'workload.priority_mix[i]', 0, 1), 0);
  if (Math.abs(sum - 1) > 1e-6) fail(path, `workload.priority_mix must sum to 1 (got ${sum})`);
  for (const p of ['1', '2', '3'] as const) {
    const d = wl.deadline_s[p];
    if (!Array.isArray(d) || d.length !== 2 || d[0] > d[1]) fail(path, `workload.deadline_s.${p} must be [min, max]`);
  }
  num(path, s.network.range_m, 'network.range_m', 10, 100000);
  num(path, s.network.loss, 'network.loss', 0, 1);
  num(path, s.policy.lease_ttl_s, 'policy.lease_ttl_s', 1, 3600);
  num(path, s.policy.soc_reserve, 'policy.soc_reserve', 0, 0.9);
  if (!['STRICT', 'QUORUM', 'OPTIMISTIC_BOUNDED'].includes(s.policy.partition)) fail(path, `policy.partition must be STRICT | QUORUM | OPTIMISTIC_BOUNDED`);
  // scripted tasks: inline list or file reference
  if (typeof rawTasks === 'string') {
    const list = resolveTasks(rawTasks);
    if (!list) fail(path, `workload.tasks file "${rawTasks}" not found under scenarios/`);
    wl.tasks = list;
    wl.tasks_file = rawTasks;
  } else if (Array.isArray(rawTasks)) {
    wl.tasks = parseTasksYaml(JSON.stringify(rawTasks), path);
  } else wl.tasks = [];
  if (!Array.isArray(s.faults)) fail(path, 'faults must be a list');
  s.faults.forEach((fd, i) => {
    if (!isObj(fd) || typeof fd.t !== 'number' || typeof fd.type !== 'string') fail(path, `faults[${i}] needs numeric t and a type`);
  });
  s.faults = [...s.faults].sort((a, b) => a.t - b.t) as FaultDef[];
  return s;
}

/** PRD ground {x, y} → world {x, z}. */
export function groundToWorld(p: { x: number; y: number }): { x: number; z: number } {
  return { x: p.x, z: p.y };
}

/** World generator config derived from a scenario. */
export function worldConfigFrom(s: Scenario): WorldGenConfig {
  const noFly: NoFlySpec[] = s.world.no_fly.map((n) => {
    if (n === 'auto') return 'auto';
    const spec: Exclude<NoFlySpec, 'auto'> = { id: n.id, name: n.name, reason: n.reason, maxY: n.max_alt_m, closable: n.closable, active: n.active };
    if (n.circle) spec.circle = { x: n.circle.x, z: n.circle.y, r: n.circle.r };
    if (n.box) spec.box = { minX: Math.min(n.box.x0, n.box.x1), maxX: Math.max(n.box.x0, n.box.x1), minZ: Math.min(n.box.y0, n.box.y1), maxZ: Math.max(n.box.y0, n.box.y1) };
    if (n.polygon) spec.polygon = n.polygon.map(groundToWorld);
    return spec;
  });
  return {
    seed: s.seed,
    size: s.world.size_m[0],
    depots: s.world.depots,
    padsPerDepot: s.world.pads_per_depot,
    dropPointsPerKm2: s.world.drop_points_per_km2,
    noFly,
    wind: s.world.wind,
  };
}

/** Convenience for tests: a scenario with overrides applied (same validation path). */
export function scenarioWith(base: Scenario, over: DeepPartial<Scenario>): Scenario {
  return loadScenario(merge(base as unknown as DeepPartial<Scenario>, over), `${base.name}+override`, () => base.workload.tasks);
}
