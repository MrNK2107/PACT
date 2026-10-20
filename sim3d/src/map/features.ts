import { featuresForSize, type LayoutFeatures, type WorldWater } from '../world/features';
import type { MapDef } from './types';

/**
 * Generator feature flags for a map. Every flag the map leaves undefined falls back to the legacy
 * size-derived value (computed from `size`, the scenario's world size), so a legacy map generates the
 * same world it always did.
 */
export function featuresFromMap(map: MapDef, size: number): LayoutFeatures {
  const base = featuresForSize(size);
  const g = map.geography;
  const water: WorldWater = g.water;
  const lm = g.landmarks;
  return {
    water,
    airport: g.airport ?? base.airport,
    port: g.port ?? base.port,
    rail: g.rail ?? base.rail,
    motorwayRing: g.motorway_ring ?? base.motorwayRing,
    secondaryCentres: g.secondary_centres ?? base.secondaryCentres,
    specials: { ...base.specials, ...g.specials },
    landmarks: lm ? { landmarktower: lm.includes('landmarktower'), cathedral: lm.includes('cathedral'), tvmast: lm.includes('tvmast'), gasometer: lm.includes('gasometer') } : base.landmarks,
    oldTownDistricts: g.old_town_districts ?? base.oldTownDistricts,
    tall: g.tall_buildings ?? base.tall,
    turbines: g.turbines ?? base.turbines,
    powerLines: g.power_lines ?? base.powerLines,
    dynamicObstacleDensity: g.dynamic_obstacle_density ?? base.dynamicObstacleDensity,
    districtBias: { ...g.district_bias },
  };
}
