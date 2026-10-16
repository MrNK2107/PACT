import { parse } from 'yaml';
import { DEPOT_LAYOUTS, TIERS, WATER_MODES, type MapDef } from './types';

const WEATHER_TYPES = ['weather_front', 'storm_cell', 'altitude_cap'];
const BIAS_KEYS = ['cbd', 'industrial', 'park', 'suburb', 'farmland'];
const LANDMARKS = ['landmarktower', 'cathedral', 'tvmast', 'gasometer'];

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
  const radio = isObj(mech.radio) ? mech.radio : {};
  if (radio.zones !== undefined && !Array.isArray(radio.zones)) fail(path, 'mechanics.radio.zones must be a list');
  if (mech.weather !== undefined && !Array.isArray(mech.weather)) fail(path, 'mechanics.weather must be a list');
  const weather = (mech.weather as unknown[] | undefined) ?? [];
  weather.forEach((w, i) => {
    if (!isObj(w) || typeof w.t !== 'number' || !WEATHER_TYPES.includes(String(w.type))) fail(path, `mechanics.weather[${i}] needs a numeric t and a type of ${WEATHER_TYPES.join(' | ')}`);
  });
  const layout = oneOf(path, dep.layout ?? 'distributed', 'logistics.depots.layout', DEPOT_LAYOUTS);
  const optBool = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') fail(path, `${name} must be true or false, got ${JSON.stringify(v)}`);
    return v;
  };
  const optNum = (v: unknown, name: string, lo: number, hi: number): number | undefined => (v === undefined ? undefined : num(path, v, name, lo, hi));
  const specialsRaw = isObj(geo.specials) ? geo.specials : {};
  const biasRaw = isObj(geo.district_bias) ? geo.district_bias : {};
  for (const k of Object.keys(biasRaw)) if (!BIAS_KEYS.includes(k)) fail(path, `geography.district_bias.${k} is not one of ${BIAS_KEYS.join(' | ')}`);
  if (geo.landmarks !== undefined && !Array.isArray(geo.landmarks)) fail(path, 'geography.landmarks must be a list');
  const landmarks = Array.isArray(geo.landmarks) ? geo.landmarks.map(String) : undefined;
  for (const l of landmarks ?? []) if (!LANDMARKS.includes(l)) fail(path, `geography.landmarks has unknown landmark "${l}" (use ${LANDMARKS.join(' | ')})`);
  const bias: NonNullable<MapDef['geography']['district_bias']> = {};
  for (const k of BIAS_KEYS) if (biasRaw[k] !== undefined) bias[k as keyof typeof bias] = num(path, biasRaw[k], `geography.district_bias.${k}`, 0.1, 5);
  const specials: NonNullable<MapDef['geography']['specials']> = {};
  for (const k of ['hospital', 'campus', 'stadium', 'cemetery'] as const) if (specialsRaw[k] !== undefined) specials[k] = num(path, specialsRaw[k], `geography.specials.${k}`, 0, 8);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    tier: oneOf(path, raw.tier ?? 'standard', 'tier', TIERS),
    seed: raw.seed === undefined ? undefined : num(path, raw.seed, 'seed', 0, 2 ** 31),
    size_m: num(path, raw.size_m ?? 4000, 'size_m', 1500, 20000),
    hidden: raw.hidden === true,
    geography: {
      water: oneOf(path, geo.water ?? 'coast_river', 'geography.water', WATER_MODES),
      airport: optBool(geo.airport, 'geography.airport'),
      port: optBool(geo.port, 'geography.port'),
      rail: optBool(geo.rail, 'geography.rail'),
      motorway_ring: optBool(geo.motorway_ring, 'geography.motorway_ring'),
      secondary_centres: optNum(geo.secondary_centres, 'geography.secondary_centres', 0, 6),
      landmarks,
      specials: Object.keys(specials).length ? specials : undefined,
      old_town_districts: optNum(geo.old_town_districts, 'geography.old_town_districts', 0, 6),
      tall_buildings: optBool(geo.tall_buildings, 'geography.tall_buildings'),
      turbines: optNum(geo.turbines, 'geography.turbines', 0, 12),
      power_lines: optBool(geo.power_lines, 'geography.power_lines'),
      dynamic_obstacle_density: optNum(geo.dynamic_obstacle_density, 'geography.dynamic_obstacle_density', 0, 5),
      district_bias: Object.keys(bias).length ? bias : undefined,
    },
    logistics: {
      depots: { layout, count: num(path, dep.count ?? 3, 'logistics.depots.count', 1, 8), pads: num(path, dep.pads ?? 2, 'logistics.depots.pads', 1, layout === 'single_hub' ? 6 : 3) },
      drop_points_per_km2: num(path, log.drop_points_per_km2 ?? 35, 'logistics.drop_points_per_km2', 1, 200),
      rooftop_only: log.rooftop_only === true,
      public_pads: num(path, log.public_pads ?? 0, 'logistics.public_pads', 0, 8),
    },
    mechanics: {
      wind: {
        mean_mps: num(path, wind.mean_mps ?? 4, 'mechanics.wind.mean_mps', 0, 30),
        dir_deg: wind.dir_deg === undefined ? undefined : num(path, wind.dir_deg, 'mechanics.wind.dir_deg', 0, 360),
        gust_mps: wind.gust_mps === undefined ? undefined : num(path, wind.gust_mps, 'mechanics.wind.gust_mps', 0, 30),
      },
      radio: { dead_zones: oneOf(path, radio.dead_zones ?? 'none', 'mechanics.radio.dead_zones', ['none', 'auto'] as const), zones: (radio.zones as MapDef['mechanics']['radio']['zones'] | undefined) ?? [] },
      weather: weather as MapDef['mechanics']['weather'],
    },
    no_fly: Array.isArray(raw.no_fly) ? (raw.no_fly as MapDef['no_fly']) : ['auto'],
    scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.map(String) : [],
  };
}
