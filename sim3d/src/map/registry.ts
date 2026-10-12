import { loadMap } from './load';
import type { MapDef } from './types';

/** Every YAML under sim3d/maps/ is bundled (Vite import.meta.glob with ?raw), parsed and validated at start-up. */
const mapFiles = import.meta.glob('../../maps/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

export const MAPS: Record<string, MapDef> = {};
for (const [path, text] of Object.entries(mapFiles)) {
  const file = path.replace(/^.*\//, '');
  const m = loadMap(text, file);
  if (MAPS[m.id]) throw new Error(`map ${file}: duplicate map id "${m.id}"`);
  MAPS[m.id] = m;
}

export const DEFAULT_MAP = 'coastal_metro';
export const MAP_IDS = Object.keys(MAPS).sort();
/** Maps offered in the picker (fixtures are hidden). */
export const VISIBLE_MAP_IDS = MAP_IDS.filter((id) => !MAPS[id].hidden);

export function findMap(id: string): MapDef | null {
  return MAPS[id] ?? null;
}

export function getMap(id: string | null | undefined): MapDef {
  if (id && MAPS[id]) return MAPS[id];
  return MAPS[DEFAULT_MAP] ?? MAPS[MAP_IDS[0]];
}
