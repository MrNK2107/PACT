import type { FaultDef, NoFlyFileSpec, RadioFileSpec } from '../scenario/types';
import type { DepotLayout } from '../world/features';

export type { DepotLayout };

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
    /** Optional flags; undefined = derived from the map size like the legacy generator. */
    airport?: boolean;
    port?: boolean;
    rail?: boolean;
    motorway_ring?: boolean;
    secondary_centres?: number;
    /** Landmarks to place, from landmarktower | cathedral | tvmast | gasometer. */
    landmarks?: string[];
    specials?: { hospital?: number; campus?: number; stadium?: number; cemetery?: number };
    old_town_districts?: number;
    tall_buildings?: boolean;
    turbines?: number;
    power_lines?: boolean;
    dynamic_obstacle_density?: number;
    /** Multipliers tilting the district mix: cbd, industrial, park, suburb, farmland. */
    district_bias?: { cbd?: number; industrial?: number; park?: number; suburb?: number; farmland?: number };
  };
  logistics: {
    depots: { layout: DepotLayout; count: number; pads: number };
    drop_points_per_km2: number;
    /** Drop points only on rooftops (dense-city maps). */
    rooftop_only: boolean;
    /** Standalone public charging pads outside the depots. */
    public_pads: number;
  };
  mechanics: {
    wind: { mean_mps: number; dir_deg?: number; gust_mps?: number };
    /** Radio dead zones: none, generated from the city (urban canyons, industrial clutter), plus explicit zones. */
    radio: { dead_zones: 'none' | 'auto'; zones: RadioFileSpec[] };
    /** Default weather schedule (weather_front, storm_cell, altitude_cap) applied to every scenario on the map. */
    weather: FaultDef[];
  };
  no_fly: ('auto' | NoFlyFileSpec)[];
  /** Curated, ordered scenario names for the picker. Unlisted scenarios of the map follow alphabetically. */
  scenarios: string[];
}
