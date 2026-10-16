import type { DepotLayout, LayoutFeatures } from './features';
/**
 * World data model.
 *
 * Coordinate system (right-handed, metres):
 *   +X = east, +Z = south (towards the default camera), +Y = altitude above ground (up).
 * Every element has a stable string id and world coordinates. Nothing here depends on
 * screen coordinates, React, or Three.js, so path planners / ROS 2 bridges can consume it as-is.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export type ZoneType = 'residential' | 'commercial' | 'industrial' | 'park' | 'civic' | 'transport' | 'water' | 'perimeter' | 'rural';

/** Land-use category of one super-block (the cell between four arterial roads). */
export type DistrictKind =
  | 'cbd'
  | 'commercial'
  | 'mixed'
  | 'apartments'
  | 'townhouses'
  | 'houses'
  | 'suburb'
  | 'industrial'
  | 'logistics'
  | 'port'
  | 'park'
  | 'campus'
  | 'hospital'
  | 'stadium'
  | 'airport'
  | 'cemetery'
  | 'waterfront'
  | 'farmland'
  | 'water';

export interface ZoneData {
  id: string;
  type: ZoneType;
  name: string;
  /** Axis-aligned footprint in XZ. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface DistrictData {
  id: string;
  kind: DistrictKind;
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** 0 (edge of town) … 1 (city centre). */
  centrality: number;
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  minY: number;
  maxY: number;
}

export type RoadKind = 'motorway' | 'arterial' | 'collector' | 'local' | 'service';

export interface RoadData {
  id: string;
  name: string;
  kind: RoadKind;
  /** 'EW' runs along X at fixed z=c, 'NS' runs along Z at fixed x=c. */
  dir: 'EW' | 'NS';
  c: number;
  a: number;
  b: number;
  width: number;
  lanes: number;
  /** Intervals along the road carried on bridges (over water / rail). */
  bridges?: { a: number; b: number }[];
}

/** Road crossing (derived once at generation time; the map is far too large to recompute per render). */
export interface JunctionData {
  x: number;
  z: number;
  /** Width of the EW / NS roads meeting here. */
  wEW: number;
  wNS: number;
  kind: RoadKind;
}

/** Axis-aligned railway segment (ballast + twin rails). */
export interface RailData {
  id: string;
  dir: 'EW' | 'NS';
  c: number;
  a: number;
  b: number;
  width: number;
  bridges?: { a: number; b: number }[];
}

export interface StationData {
  id: string;
  name: string;
  x: number;
  z: number;
  /** Platform length along the line. */
  length: number;
  dir: 'EW' | 'NS';
}

export interface BlockData {
  id: string;
  zone: ZoneType;
  districtId: string;
  kind: string;
  cx: number;
  cz: number;
  w: number;
  d: number;
  /** Ground colour of the inner lot. */
  lotColor: string;
  /** Surface of the inner lot. */
  surface: 'lawn' | 'paving' | 'gravel' | 'asphalt' | 'sand' | 'turf';
}

export type BuildingKind =
  | 'house'
  | 'townhouse'
  | 'garage'
  | 'apartment'
  | 'slab'
  | 'tower'
  | 'crown'
  | 'spire'
  | 'midrise'
  | 'podium'
  | 'hotel'
  | 'pavilion'
  | 'kiosk'
  | 'warehouse'
  | 'distribution'
  | 'factory'
  | 'shed'
  | 'office'
  | 'mall'
  | 'bigbox'
  | 'supermarket'
  | 'school'
  | 'hospital'
  | 'church'
  | 'parking'
  | 'station'
  | 'terminal'
  | 'hangar'
  | 'stadium'
  | 'substation'
  | 'tank'
  | 'silo'
  | 'frame'
  | 'watertower'
  | 'gasstation'
  | 'pier';

export type RoofKind = 'flat' | 'gable' | 'hip' | 'sawtooth' | 'barrel';

export interface BuildingData {
  id: string;
  name: string;
  kind: BuildingKind;
  zone: ZoneType;
  blockId: string;
  cx: number;
  cz: number;
  /** Footprint size (x, z). */
  w: number;
  d: number;
  /** Height of the main volume. */
  h: number;
  baseY: number;
  roof: RoofKind;
  /** Roof style / tint, hex. */
  color: string;
  material: 'plaster' | 'brick' | 'concrete' | 'glass' | 'metal' | 'corrugated' | 'stone' | 'panel';
  hasBalconies: boolean;
  /** Solid collision volume (includes roof equipment / masts for flat roofs). */
  bounds: AABB;
  rooftopPadIds: string[];
  /** Rotation about Y (radians) — only used for a handful of free-standing landmarks. */
  rot?: number;
}

export interface TreeData {
  id: string;
  x: number;
  z: number;
  height: number;
  radius: number;
  species: 'broadleaf' | 'conifer' | 'palm' | 'cypress';
  shade: number;
}

export interface StreetlightData {
  x: number;
  z: number;
  rot: number;
}

export interface RoofEquipment {
  type: 'hvac' | 'tank' | 'mast' | 'solar' | 'skylight' | 'stairhead';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  buildingId: string;
}

export interface BalconyData {
  x: number;
  y: number;
  z: number;
  sx: number;
  sz: number;
  rot: number;
}

export interface VehicleRoute {
  id: string;
  type: 'car' | 'van' | 'truck' | 'bus';
  roadId: string;
  dir: 'EW' | 'NS';
  c: number;
  a: number;
  b: number;
  /** +1 travels toward increasing coordinate, -1 toward decreasing. */
  lane: 1 | -1;
  laneOffset: number;
  speed: number;
  phase: number;
  color: string;
}

export interface ContainerStack {
  x: number;
  z: number;
  rot: number;
  stack: number;
  color: string;
}

export interface ParkingSpace {
  x: number;
  z: number;
  rot: number;
  w: number;
  d: number;
}

/** Small decorative street / lot furniture (instanced, never an obstacle). */
export interface PropData {
  type: 'bench' | 'bin' | 'busstop' | 'billboard' | 'fountain' | 'playground' | 'pool' | 'pitch' | 'court' | 'solarfarm' | 'runway' | 'taxiway' | 'helipad' | 'boat' | 'buoy' | 'fence' | 'hedge' | 'planter' | 'crosswalk' | 'turbine' | 'platform' | 'canopy' | 'pumps' | 'grave';
  x: number;
  z: number;
  rot: number;
  sx: number;
  sz: number;
  color?: string;
}

export type SiteKind = 'depot' | 'drop';

export interface PadData {
  id: string;
  /** Landing centre (y = surface the drone rests on). */
  pos: Vec3;
  radius: number;
  rooftop: boolean;
  /** Owning depot; '' for a public pad outside any depot. */
  depotId: string;
  /** False while the pad / charger is out of service (pad_outage, depot_outage). */
  enabled: boolean;
}

export interface ChargerData {
  id: string;
  depotId: string;
  pos: Vec3;
  padId: string;
}

/**
 * A depot is a *local resource* (PRD 3.2 / assumption T9): parcel hand-off bays where pickups happen,
 * plus 1–3 scarce charging pads. It is never a fleet controller.
 */
export interface DepotData {
  id: string;
  name: string;
  kind: 'depot';
  zone: ZoneType;
  districtId: string;
  rooftop: boolean;
  pos: Vec3;
  buildingId: string;
  padIds: string[];
  chargerIds: string[];
  /** Parcel hand-off bays: `Task.pickup` positions. */
  handoff: Vec3[];
  /** Paved apron (keep-out for other generators). */
  apron: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Shard ids in this depot's catchment (nearest-depot rule). */
  catchmentShards: string[];
}

export type DropType = 'hospital' | 'clinic' | 'office' | 'retail' | 'residential' | 'industrial' | 'campus' | 'event' | 'park';

export interface DropPointData {
  id: string;
  name: string;
  kind: 'drop';
  type: DropType;
  zone: ZoneType;
  clusterId: string;
  pos: Vec3;
  buildingId?: string;
  rooftop: boolean;
  /** Relative demand weight used by the workload generator. */
  demand: number;
  shard: string;
  nearestDepotId: string;
}

/** Demand hotspot (one per district) used for clustered workloads (REQ-SIM-005). */
export interface DemandCluster {
  id: string;
  districtId: string;
  type: DropType;
  cx: number;
  cz: number;
  radius: number;
  demand: number;
  pointIds: string[];
}

export interface AABB2 {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export type NoFlyShape =
  | { type: 'circle'; x: number; z: number; r: number }
  | { type: 'box'; minX: number; maxX: number; minZ: number; maxZ: number }
  | { type: 'polygon'; points: { x: number; z: number }[]; bbox: AABB2 };

export interface NoFlyZone {
  id: string;
  name: string;
  reason: string;
  shape: NoFlyShape;
  maxY: number;
  /** The zone applies at altitudes from `minY` (default 0). A zone with `minY > 0` is a ceiling: flight below it is allowed. */
  minY?: number;
  /** Zone can be opened / closed at runtime (`close_zone` fault). */
  closable: boolean;
  /** Only active zones constrain flight. */
  active: boolean;
  closedFrom?: number;
  closedUntil?: number;
  source: 'auto' | 'scenario' | 'fault';
}

/** Radio dead zone: degrades links with an endpoint inside it (sim/Radio.ts applies the effect). */
export interface RadioZone {
  id: string;
  name: string;
  shape: NoFlyShape;
  /** Multiplier on the radio range for links touching the zone (0 = dark). */
  rangeFactor: number;
  /** Extra packet-loss probability for links touching the zone. */
  lossAdd: number;
  /** The zone applies at and below this altitude. */
  maxY: number;
  active: boolean;
  closedFrom?: number;
  closedUntil?: number;
  source: 'auto' | 'scenario' | 'fault';
}

/** Radio zone specification as written in a scenario / map file (ground coordinates already mapped to x/z). */
export interface RadioSpec {
  id?: string;
  name?: string;
  circle?: { x: number; z: number; r: number };
  box?: { minX: number; maxX: number; minZ: number; maxZ: number };
  polygon?: { x: number; z: number }[];
  rangeFactor?: number;
  loss?: number;
  maxY?: number;
  active?: boolean;
}

/** Wind field sampled on a regular grid (m/s). Affects energy only (assumption T11). */
export interface WindField {
  cell: number;
  nx: number;
  nz: number;
  originX: number;
  originZ: number;
  mean: number;
  dirDeg: number;
  gust: number;
  vx: Float32Array;
  vz: Float32Array;
  /** Generation data, kept so weather fronts can retarget the field (see world/Wind.ts). */
  seed?: number;
  bounds?: WorldBounds;
  water?: Uint8Array;
}

/** 500 m pointy-top hex shard grid (PRD section 15). */
export interface ShardGrid {
  size: number;
  originX: number;
  originZ: number;
  ids: string[];
  /** shard id -> depot id whose catchment contains the hex centre. */
  depotOf: Record<string, string>;
}

/** Obstacle form consumed by the ObstacleManager / PathPlanner. */
export interface StaticObstacle {
  id: string;
  category: 'building' | 'crane' | 'utility' | 'tree' | 'equipment';
  shape: 'box' | 'cylinder';
  bounds: AABB;
  /** For cylinders: centre and radius in XZ. */
  cx: number;
  cz: number;
  r: number;
  name?: string;
}

export interface CraneData {
  id: string;
  x: number;
  z: number;
  mastHeight: number;
  jibLength: number;
  jibAngle: number;
  kind: 'tower' | 'gantry' | 'quay';
}

export interface UtilityStructure {
  id: string;
  kind: 'pylon' | 'tank' | 'stack' | 'turbine' | 'watertower' | 'silo' | 'mast';
  x: number;
  z: number;
  height: number;
  radius: number;
}

/** Sequence of pylons joined by overhead conductors. */
export interface PowerLineData {
  id: string;
  pylonIds: string[];
}

export interface LoadingBay {
  id: string;
  x: number;
  z: number;
  rot: number;
  buildingId: string;
}

export interface DynamicObstacleDef {
  id: string;
  name: string;
  radius: number;
  kind: 'balloon' | 'blimp' | 'helicopter';
  /** Deterministic parametric motion. */
  motion:
    | { type: 'orbit'; cx: number; cz: number; r: number; y: number; speed: number; phase: number }
    | { type: 'patrol'; ax: number; az: number; bx: number; bz: number; y: number; speed: number };
}

/** Polyline water body (river) or coastline, sampled at fixed intervals along Z. */
export interface RiverData {
  id: string;
  name: string;
  /** Centre-line samples (ordered). */
  points: { x: number; z: number }[];
  width: number;
  waterY: number;
}

export interface CoastData {
  /** Shoreline x as a function of z (ordered by z). Sea lies at x > shore. */
  shore: { x: number; z: number }[];
  waterY: number;
}

export interface WorldData {
  seed: number;
  /** Side length of the generated map, metres. */
  size: number;
  bounds: WorldBounds;
  rivers: RiverData[];
  coast: CoastData | null;
  districts: DistrictData[];
  zones: ZoneData[];
  roads: RoadData[];
  junctions: JunctionData[];
  rails: RailData[];
  stations: StationData[];
  blocks: BlockData[];
  buildings: BuildingData[];
  trees: TreeData[];
  streetlights: StreetlightData[];
  equipment: RoofEquipment[];
  balconies: BalconyData[];
  vehicles: VehicleRoute[];
  containers: ContainerStack[];
  parking: ParkingSpace[];
  props: PropData[];
  loadingBays: LoadingBay[];
  cranes: CraneData[];
  utilities: UtilityStructure[];
  powerLines: PowerLineData[];
  depots: DepotData[];
  pads: PadData[];
  chargers: ChargerData[];
  dropPoints: DropPointData[];
  clusters: DemandCluster[];
  noFlyZones: NoFlyZone[];
  radioZones: RadioZone[];
  wind: WindField;
  shards: ShardGrid;
  obstacles: StaticObstacle[];
  dynamicObstacles: DynamicObstacleDef[];
  /** id -> record, for inspection. */
  index: Map<string, { type: string; data: unknown }>;
  /** Generation statistics (for the UI / tests). */
  stats: Record<string, number>;
}

/** No-fly zone specification as written in a scenario file (PRD ground coordinates already mapped to x/z). */
export type NoFlySpec =
  | 'auto'
  | {
      id?: string;
      name?: string;
      reason?: string;
      circle?: { x: number; z: number; r: number };
      box?: { minX: number; maxX: number; minZ: number; maxZ: number };
      polygon?: { x: number; z: number }[];
      maxY?: number;
      closable?: boolean;
      active?: boolean;
    };

export interface WorldGenConfig {
  seed: number;
  /** Generator feature flags; defaults to the legacy size-derived set. */
  features?: LayoutFeatures;
  /** How depots are sited (default distributed). */
  depotLayout?: DepotLayout;
  /** Drop points only on rooftops (dense-city maps). */
  rooftopOnly?: boolean;
  /** Side length of the square map in metres (PRD default 4 000). */
  size: number;
  /** Number of depots (1–8). */
  depots: number;
  /** Charging pads per depot (1–3). */
  padsPerDepot: number;
  /** Target density of drop points. */
  dropPointsPerKm2: number;
  noFly: NoFlySpec[];
  /** Standalone public charging pads outside the depots. */
  publicPads?: number;
  /** Radio dead zones: generated automatically and/or listed explicitly. Absent = none. */
  radio?: { auto: boolean; zones: RadioSpec[] };
  wind: { mean_mps: number; dir_deg?: number; gust_mps?: number };
  /** Flight-envelope boundary. Defaults to the full generated map. */
  bounds?: WorldBounds;
}
