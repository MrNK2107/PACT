import { SYSTEM_IDS } from '../sim/systems';
import { parse } from 'yaml';
import { featuresFromMap } from '../map/features';
import { findMap } from '../map/registry';
import type { MapDef } from '../map/types';
import { TIERS } from '../map/types';
import { featuresForSize } from '../world/features';
import { radioSpecsFrom } from '../world/Radio';
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
/** Defaults a map contributes under a scenario's own values (scenario file wins; PRD defaults sit below). */
export function mapDefaults(m: MapDef): DeepPartial<Scenario> {
  return {
    ...(m.seed !== undefined ? { seed: m.seed } : {}),
    world: {
      size_m: [m.size_m, m.size_m],
      depots: m.logistics.depots.count,
      pads_per_depot: m.logistics.depots.pads,
      public_pads: m.logistics.public_pads,
      drop_points_per_km2: m.logistics.drop_points_per_km2,
      no_fly: m.no_fly,
      radio_zones: m.mechanics.radio.zones,
      wind: m.mechanics.wind,
    },
  } as DeepPartial<Scenario>;
}

export function loadScenario(
  raw: DeepPartial<Scenario>,
  path: string,
  resolveTasks: (ref: string) => ScriptedTaskSpec[] | null = () => null,
  resolveMap?: (id: string) => MapDef | null,
): Scenario {
  const rawTasks = (raw.workload as { tasks?: unknown } | undefined)?.tasks;
  // a scenario without a workload block keeps the defaults (an explicit undefined would erase them)
  const over: DeepPartial<Scenario> = { ...raw };
  if (raw.workload) over.workload = { ...raw.workload, tasks: undefined };
  let base: Scenario = SCENARIO_DEFAULTS;
  let map: MapDef | null = null;
  if (resolveMap) {
    const mapId = typeof raw.map === 'string' && raw.map ? raw.map : SCENARIO_DEFAULTS.map;
    map = resolveMap(mapId);
    if (!map) fail(path, `unknown map "${mapId}"`);
    const rawSize = (raw.world as { size_m?: unknown } | undefined)?.size_m;
    if (rawSize !== undefined && (!Array.isArray(rawSize) || rawSize[0] !== map.size_m || rawSize[1] !== map.size_m)) {
      fail(path, `world.size_m ${JSON.stringify(rawSize)} conflicts with map "${map.id}" (${map.size_m} m); size belongs to the map`);
    }
    base = merge(SCENARIO_DEFAULTS, mapDefaults(map));
  }
  const s = merge(base, over);
  if (s.tier !== undefined && !TIERS.includes(s.tier)) fail(path, `tier must be one of ${TIERS.join(' | ')}, got ${JSON.stringify(s.tier)}`);
  if (!Array.isArray(s.tags)) fail(path, 'tags must be a list');
  s.name = typeof raw.name === 'string' && raw.name ? raw.name : path.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/, '');
  if (s.system !== undefined && !SYSTEM_IDS.includes(s.system)) fail(path, `system must be one of ${SYSTEM_IDS.join(' | ')}, got ${JSON.stringify(s.system)}`);
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
  num(path, w.pads_per_depot, 'world.pads_per_depot', 1, map?.logistics.depots.layout === 'single_hub' ? 6 : 3);
  num(path, w.public_pads, 'world.public_pads', 0, 8);
  num(path, w.drop_points_per_km2, 'world.drop_points_per_km2', 1, 200);
  num(path, w.wind.mean_mps, 'world.wind.mean_mps', 0, 30);
  if (!Array.isArray(w.no_fly)) fail(path, 'world.no_fly must be a list');
  if (!Array.isArray(w.radio_zones)) fail(path, 'world.radio_zones must be a list');
  w.radio_zones.forEach((z, i) => radioSpec(path, z, `world.radio_zones[${i}]`));
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
  const lat = s.network.latency_ms;
  if (!Array.isArray(lat) || lat.length !== 2) fail(path, 'network.latency_ms must be [min, max]');
  num(path, lat[0], 'network.latency_ms[0]', 0, 60000);
  num(path, lat[1], 'network.latency_ms[1]', lat[0], 60000);
  const bh = s.network.backhaul as unknown;
  if (!isObj(bh)) fail(path, 'network.backhaul must be { enabled, latency_ms, loss }');
  if (typeof bh.enabled !== 'boolean') fail(path, 'network.backhaul.enabled must be true or false');
  num(path, bh.loss, 'network.backhaul.loss', 0, 1);
  const bl = bh.latency_ms;
  if (!Array.isArray(bl) || bl.length !== 2) fail(path, 'network.backhaul.latency_ms must be [min, max]');
  num(path, bl[0], 'network.backhaul.latency_ms[0]', 0, 60000);
  num(path, bl[1], 'network.backhaul.latency_ms[1]', bl[0] as number, 60000);
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
  // the map's default weather schedule runs in every scenario on it
  if (map && map.mechanics.weather.length) s.faults = [...map.mechanics.weather, ...s.faults];
  s.faults.forEach((fd, i) => {
    if (!isObj(fd) || typeof fd.t !== 'number' || typeof fd.type !== 'string') fail(path, `faults[${i}] needs numeric t and a type`);
    if (fd.type === 'radio_blackout') radioSpec(path, fd, `faults[${i}]`, true);
    if (fd.type === 'weather_front' || fd.type === 'storm_cell' || fd.type === 'altitude_cap') weatherFault(path, fd, `faults[${i}]`);
    if ((fd.type === 'pad_outage' || fd.type === 'depot_outage') && typeof fd.id !== 'string') fail(path, `faults[${i}] (${fd.type}) needs the id of a ${fd.type === 'pad_outage' ? 'pad' : 'depot'}`);
    if (fd.type === 'partition' || fd.type === 'link_loss' || fd.type === 'clock_drift' || fd.type === 'backhaul_cut') networkFault(path, fd, `faults[${i}]`);
  });
  s.faults = [...s.faults].sort((a, b) => a.t - b.t) as FaultDef[];
  return s;
}

/** Validates weather faults: wind front, storm cell, altitude cap. */
function weatherFault(path: string, f: Record<string, unknown>, where: string): void {
  const opt = (k: string, lo: number, hi: number) => {
    if (f[k] !== undefined) num(path, f[k], `${where}.${k}`, lo, hi);
  };
  if (f.until !== undefined) num(path, f.until, `${where}.until`, 0, 1e7);
  if (f.type === 'weather_front') {
    if (f.mean_mps === undefined && f.dir_deg === undefined && f.gust_mps === undefined) fail(path, `${where} (weather_front) needs mean_mps, dir_deg or gust_mps`);
    opt('mean_mps', 0, 40);
    opt('dir_deg', 0, 360);
    opt('gust_mps', 0, 30);
    opt('ramp_s', 0, 3600);
  } else if (f.type === 'storm_cell') {
    const c = f.circle as { r?: unknown } | undefined;
    if (!isObj(c) || typeof c.r !== 'number' || !(c.r > 0)) fail(path, `${where} (storm_cell) needs circle {x, y, r > 0}`);
    if (f.to !== undefined && !isObj(f.to)) fail(path, `${where}.to must be {x, y}`);
    opt('duration_s', 1, 1e6);
    opt('wind_mps', 0, 40);
    opt('ceiling_m', 10, 200);
  } else {
    num(path, f.cap_m, `${where}.cap_m`, 10, 200);
    if (f.circle !== undefined && !isObj(f.circle)) fail(path, `${where}.circle must be {x, y, r}`);
  }
}

/** Validates network faults: partition, link_loss, clock_drift. Node ids are checked against the run at fault time. */
function networkFault(path: string, f: Record<string, unknown>, where: string): void {
  if (f.until !== undefined) num(path, f.until, `${where}.until`, 0, 1e7);
  if (f.type === 'partition') {
    const g = f.groups;
    if (!Array.isArray(g) || g.length < 2 || !g.every((x) => Array.isArray(x) && x.every((id) => typeof id === 'string'))) fail(path, `${where} (partition) needs groups: a list of at least 2 lists of node ids`);
    const seen = new Set<string>();
    for (const id of (g as string[][]).flat()) {
      if (seen.has(id)) fail(path, `${where} (partition) lists ${id} in more than one group`);
      seen.add(id);
    }
    return;
  }
  if (f.type === 'backhaul_cut') {
    if (f.depots !== undefined && (!Array.isArray(f.depots) || !f.depots.every((d) => typeof d === 'string'))) fail(path, `${where} (backhaul_cut) depots must be a list of depot ids`);
    return;
  }
  if (typeof f.id !== 'string') fail(path, `${where} (${f.type}) needs the id of a drone or depot`);
  if (f.type === 'link_loss') {
    if (f.loss !== undefined) num(path, f.loss, `${where}.loss`, 0, 1);
    if (f.dir !== undefined && !['both', 'tx', 'rx'].includes(f.dir as string)) fail(path, `${where}.dir must be both | tx | rx`);
  } else num(path, f.ppm, `${where}.ppm`, -100000, 100000);
}

/** Validates the shape and numbers of a radio zone spec (file coordinates). `fault` allows a bare id reference. */
function radioSpec(path: string, z: unknown, where: string, fault = false): void {
  if (!isObj(z)) fail(path, `${where} must be a mapping`);
  if (!(z.circle || z.box || z.polygon || (fault && typeof z.id === 'string'))) fail(path, `${where} needs a circle, box or polygon${fault ? ' (or the id of an existing zone)' : ''}`);
  for (const k of ['range_factor', 'loss'] as const) if (z[k] !== undefined) num(path, z[k], `${where}.${k}`, 0, 1);
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
  const size = s.world.size_m[0];
  const map = findMap(s.map);
  return {
    seed: s.seed,
    size,
    features: map ? featuresFromMap(map, size) : featuresForSize(size),
    depotLayout: map?.logistics.depots.layout ?? 'distributed',
    rooftopOnly: map?.logistics.rooftop_only ?? false,
    terrain: map?.geography.terrain,
    depots: s.world.depots,
    padsPerDepot: s.world.pads_per_depot,
    publicPads: s.world.public_pads,
    dropPointsPerKm2: s.world.drop_points_per_km2,
    noFly,
    radio: map && (map.mechanics.radio.dead_zones === 'auto' || s.world.radio_zones.length) ? { auto: map.mechanics.radio.dead_zones === 'auto', zones: radioSpecsFrom(s.world.radio_zones) } : undefined,
    wind: s.world.wind,
  };
}

/** Convenience for tests: a scenario with overrides applied (same validation path). */
export function scenarioWith(base: Scenario, over: DeepPartial<Scenario>): Scenario {
  return loadScenario(merge(base as unknown as DeepPartial<Scenario>, over), `${base.name}+override`, () => base.workload.tasks);
}
