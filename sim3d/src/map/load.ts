import { parse } from 'yaml';
import { DEPOT_LAYOUTS, TIERS, WATER_MODES, type MapDef } from './types';

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function fail(path: string, msg: string): never {
  throw new Error(`map ${path}: ${msg}`);
}
function num(path: string, v: unknown, name: string, lo: number, hi: number): number {
  if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) fail(path, `${name} must be a number in [${lo}, ${hi}], got ${JSON.stringify(v)}`);
  return v;
}
function oneOf<T extends string>(path: string, v: unknown, name: string, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) fail(path, `${name} must be one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
  return v as T;
}

/** Parses and validates a map file. Unknown keys are ignored; invalid values fail with the file path. */
export function loadMap(text: string, path: string): MapDef {
  const raw = parse(text) as unknown;
  if (!isObj(raw)) fail(path, 'top level must be a mapping');
  const id = typeof raw.id === 'string' && raw.id ? raw.id : path.replace(/^.*[\/]/, '').replace(/\.ya?ml$/, '');
  if (!/^[a-z0-9_]+$/.test(id)) fail(path, `id "${id}" must be lowercase letters, digits and underscores`);
  const geo = isObj(raw.geography) ? raw.geography : {};
  const log = isObj(raw.logistics) ? raw.logistics : {};
  const dep = isObj(log.depots) ? log.depots : {};
  const mech = isObj(raw.mechanics) ? raw.mechanics : {};
  const wind = isObj(mech.wind) ? mech.wind : {};
  const layout = oneOf(path, dep.layout ?? 'distributed', 'logistics.depots.layout', DEPOT_LAYOUTS);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    tier: oneOf(path, raw.tier ?? 'standard', 'tier', TIERS),
    seed: raw.seed === undefined ? undefined : num(path, raw.seed, 'seed', 0, 2 ** 31),
    size_m: num(path, raw.size_m ?? 4000, 'size_m', 1500, 20000),
    hidden: raw.hidden === true,
    geography: { water: oneOf(path, geo.water ?? 'coast_river', 'geography.water', WATER_MODES) },
    logistics: {
      depots: { layout, count: num(path, dep.count ?? 3, 'logistics.depots.count', 1, 8), pads: num(path, dep.pads ?? 2, 'logistics.depots.pads', 1, layout === 'single_hub' ? 6 : 3) },
      drop_points_per_km2: num(path, log.drop_points_per_km2 ?? 35, 'logistics.drop_points_per_km2', 1, 200),
    },
    mechanics: {
      wind: {
        mean_mps: num(path, wind.mean_mps ?? 4, 'mechanics.wind.mean_mps', 0, 30),
        dir_deg: wind.dir_deg === undefined ? undefined : num(path, wind.dir_deg, 'mechanics.wind.dir_deg', 0, 360),
        gust_mps: wind.gust_mps === undefined ? undefined : num(path, wind.gust_mps, 'mechanics.wind.gust_mps', 0, 30),
      },
    },
    no_fly: Array.isArray(raw.no_fly) ? (raw.no_fly as MapDef['no_fly']) : ['auto'],
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(String) : [],
  };
}
