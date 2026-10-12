import type { NoFlyFileSpec } from '../scenario/types';

/**
 * Map definition (maps/<id>.yaml). A map fixes what kind of world a scenario runs in: size, geography,
 * logistics shape and default mechanics. Scenarios bind to a map with `map: <id>` and may only override
 * the knobs listed in `Scenario.world`; size and geography belong to the map (docs/DECISIONS.md, Decision 4).
 *
 * Geography fields left undefined mean legacy behaviour: the generator derives them from the map size
 * exactly as the single-generator code did, which keeps the legacy maps byte-identical (TC-M0 pins).
 */

export type Tier = 'tutorial' | 'standard' | 'hard' | 'stress';
export const TIERS: Tier[] = ['tutorial', 'standard', 'hard', 'stress'];

export type WaterMode = 'coast_river' | 'coast' | 'river' | 'none' | 'islands' | 'lake';
export const WATER_MODES: WaterMode[] = ['coast_river', 'coast', 'river', 'none', 'islands', 'lake'];

export type DepotLayout = 'distributed' | 'single_hub' | 'hub_and_spoke' | 'micro';
export const DEPOT_LAYOUTS: DepotLayout[] = ['distributed', 'single_hub', 'hub_and_spoke', 'micro'];

export interface MapDef {
  id: string;
  name: string;
  description: string;
  tier: Tier;
  /** Default world seed; a scenario's own seed wins. */
  seed?: number;
  size_m: number;
  /** Hidden maps (test fixtures) are loadable by id but not offered in the picker. */
  hidden: boolean;
  geography: {
    water: WaterMode;
  };
  logistics: {
    depots: { layout: DepotLayout; count: number; pads: number };
    drop_points_per_km2: number;
  };
  mechanics: {
    wind: { mean_mps: number; dir_deg?: number; gust_mps?: number };
  };
  no_fly: ('auto' | NoFlyFileSpec)[];
  /** Curated, ordered scenario names for the picker. Unlisted scenarios of the map follow alphabetically. */
  scenarios: string[];
}
