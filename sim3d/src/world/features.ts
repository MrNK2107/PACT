/**
 * Generator feature flags. Before the maps refactor every one of these was a hard-coded size threshold
 * inside the generators; `featuresForSize` reproduces those thresholds exactly, so a map that does not
 * override a flag generates the same world as before (golden pins in golden.test.ts).
 */

export type WorldWater = 'coast_river' | 'coast' | 'river' | 'none';
export type DepotLayout = 'distributed' | 'single_hub' | 'hub_and_spoke' | 'micro';

export interface LayoutFeatures {
  water: WorldWater;
  airport: boolean;
  port: boolean;
  rail: boolean;
  motorwayRing: boolean;
  secondaryCentres: number;
  specials: { hospital: number; campus: number; stadium: number; cemetery: number };
  landmarks: { landmarktower: boolean; cathedral: boolean; tvmast: boolean; gasometer: boolean };
  oldTownDistricts: number;
  /** Tall-building height caps (legacy: maps of 8 km and up). */
  tall: boolean;
  turbines: number;
  /** Power lines along the western ring motorway (needs `motorwayRing`). */
  powerLines: boolean;
  /** Multiplier on the dynamic obstacle count (legacy 1: one per 2 km2, at least 2). */
  dynamicObstacleDensity: number;
  /** Multipliers that tilt the district kind decision; absent keys mean 1 (farmland: absent means none). */
  districtBias: { cbd?: number; industrial?: number; park?: number; suburb?: number; farmland?: number };
}

export function featuresForSize(size: number): LayoutFeatures {
  const big = size >= 8000;
  return {
    water: 'coast_river',
    airport: big,
    port: size >= 5000,
    rail: size >= 5000,
    motorwayRing: size >= 4000,
    secondaryCentres: size >= 6000 ? 3 : size >= 3000 ? 1 : 0,
    specials: { hospital: big ? 4 : 2, campus: big ? 3 : 1, stadium: 1, cemetery: big ? 2 : 1 },
    landmarks: { landmarktower: true, cathedral: true, tvmast: true, gasometer: true },
    oldTownDistricts: big ? 3 : 2,
    tall: big,
    turbines: size >= 4000 ? (big ? 5 : 3) : 0,
    powerLines: true,
    dynamicObstacleDensity: 1,
    districtBias: {},
  };
}
