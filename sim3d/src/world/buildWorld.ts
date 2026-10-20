import { airportNoFly, fillBlock, fillDepot, type DepotBuild, type FillEnv, type FillOut } from './BlockFillers';
import { BuildContext, GROUND_Y } from './BuildContext';
import { generateLayout, type LayoutBlock } from './CityLayout';
import { assembleDepots, siteDepotBlocks } from './Depots';
import { generateDropPoints, planClusters } from './DropPoints';
import { placeLandmarks } from './Landmarks';
import { labelLandmasses, makeLandMask } from './LandMask';
import { sitePublicPads } from './PublicPads';
import { generateTerrain, heightAt } from './Terrain';
import { generateRadioZones, radioZoneFromSpec } from './Radio';
import { inNoFly as inNoFlyZones, zoneFromSpec } from './NoFly';
import { featuresForSize, type LayoutFeatures } from './features';
import { Noise2D } from './noise';
import { buildObstacles } from './Obstacles';
import { familyFor, makePalette, type Palette } from './palettes';
import { Rng } from './rng';
import { createShardGrid, shardOf } from './Shards';
import { generateStreetscape } from './Streetscape';
import type { DynamicObstacleDef, NoFlyZone, PowerLineData, RadioZone, UtilityStructure, WorldData, WorldGenConfig } from './types';
import { generateWind } from './Wind';

export { GROUND_Y };

export const DEFAULT_WORLD_CONFIG: WorldGenConfig = {
  seed: 20240611,
  size: 4000,
  depots: 3,
  padsPerDepot: 2,
  dropPointsPerKm2: 35,
  noFly: ['auto'],
  wind: { mean_mps: 4 },
};

/** Whether an XZ point lies inside an (active, unless `onlyActive` is false) no-fly zone. */
export function inNoFly(world: WorldData, x: number, z: number, margin = 0, onlyActive = true): boolean {
  return inNoFlyZones(world.noFlyZones, x, z, margin, onlyActive);
}

/**
 * Deterministically generates the whole logistics world from (seed, size, depots, pads, …):
 *   layout (water, roads, districts, blocks) → palettes → depot siting → block fillers →
 *   drop-point clusters → no-fly zones → wind → shards → streetscape → obstacles → index.
 */
export function createWorld(config: Partial<WorldGenConfig> = {}): WorldData {
  const cfg: WorldGenConfig = { ...DEFAULT_WORLD_CONFIG, ...config };
  if (cfg.size < 1500 || cfg.size > 20000) throw new Error(`world size ${cfg.size} m out of range (1500–20000)`);
  const f: LayoutFeatures = cfg.features ?? featuresForSize(cfg.size);
  const depotLayout = cfg.depotLayout ?? 'distributed';
  const depotsWanted = depotLayout === 'single_hub' ? 1 : Math.max(1, Math.min(8, Math.round(cfg.depots)));
  const padsPerDepot = Math.max(1, Math.min(depotLayout === 'single_hub' ? 6 : 3, Math.round(cfg.padsPerDepot)));
  const half = cfg.size / 2;
  const bounds = cfg.bounds ?? { minX: -half, maxX: half, minZ: -half, maxZ: half, minY: 0, maxY: 120 };

  const mask = f.water === 'islands' || f.water === 'lake' ? makeLandMask(f.water, cfg.seed, cfg.size) : undefined;
  const landmasses = mask ? labelLandmasses(mask, cfg.size) : undefined;
  const layout = generateLayout(cfg.seed, cfg.size, f, mask);
  // ---- terrain (own noise stream; the flat default leaves everything below untouched) --------------------------------
  // water that comes from a mask needs a height field even on a map without hills (the sea bed is carved into it)
  const terrainCfg = cfg.terrain ?? (mask ? { kind: 'hills' as const, amplitude_m: 0, wavelength_m: 2000 } : { kind: 'none' as const });
  const terrain = generateTerrain(cfg.seed, bounds, terrainCfg.kind === 'none' && mask ? { kind: 'hills', amplitude_m: 0, wavelength_m: 2000 } : terrainCfg, {
    mask,
    coast: !!layout.coast,
    river: layout.rivers.length > 0,
    shoreX: layout.shoreX,
    riverX: layout.riverX,
    riverWidth: layout.riverWidth,
    airport: layout.airport,
  });
  if (!cfg.bounds) bounds.maxY += Math.ceil(terrain.maxY);
  const ctx = new BuildContext(cfg.seed + 1);
  ctx.terrain = terrain;
  const rng = new Rng(cfg.seed + 2);
  const noise = new Noise2D(cfg.seed + 3);
  const kindNoise = new Noise2D(cfg.seed + 4);
  const skyline = new Noise2D(cfg.seed + 5);

  // ---- palettes per district -----------------------------------------------------------------------------
  const palettes = new Map<string, Palette>();
  for (const d of layout.districts) {
    const nearCoast = d.waterFrac > 0 || d.maxX > layout.shoreX((d.minZ + d.maxZ) / 2) - 500;
    palettes.set(d.id, makePalette(familyFor(d.kind, rng, nearCoast), rng));
  }

  // ---- landmarks + old town, demand clusters (district level), depot siting ---------------------------------
  const { oldTown } = placeLandmarks(layout, rng, f);
  for (const id of oldTown) {
    const d = layout.districts.find((q) => q.id === id)!;
    palettes.set(id, makePalette('old', rng));
    d.name = `Old Town (${d.name})`;
  }
  const plans = planClusters(layout, noise, rng);
  const depotBlocks = siteDepotBlocks(layout, plans, depotsWanted, depotLayout, landmasses);
  // pads per depot block: the hub of a hub-and-spoke network keeps the full count, spokes and micro depots get one
  const depotPads = new Map<string, number>();
  if (depotLayout === 'hub_and_spoke') depotBlocks.forEach((blk, i) => depotPads.set(blk.id, i === 0 ? padsPerDepot : 1));
  if (depotLayout === 'micro') depotBlocks.forEach((blk) => depotPads.set(blk.id, 1));
  // one landmark per special district: the largest block gets the hospital / stadium, the rest support it
  for (const d of layout.districts) {
    if (d.kind !== 'hospital' && d.kind !== 'stadium') continue;
    const blocks = layout.blocks.filter((b) => b.districtId === d.id && !b.kind);
    if (!blocks.length) continue;
    blocks.sort((a, b) => b.w * b.d - a.w * a.d);
    blocks[0].kind = d.kind;
    for (const b of blocks.slice(1)) b.kind = rng.pick(d.kind === 'hospital' ? ['officemid', 'parkinggarage', 'pocketpark', 'slabs', 'perimeter'] : ['parkinggarage', 'strip', 'pocketpark', 'sportsfield', 'hotel']);
  }

  // ---- block fillers ----------------------------------------------------------------------------------------
  const env: FillEnv = { rng, noise, kindNoise, skyline, layout, palettes, padsPerDepot, depotPads, tall: f.tall, kindCounts: new Map() };
  const out: FillOut = { blocks: [], props: [], parking: [], containers: [], loadingBays: [], cranes: [], utilities: [], noFly: [], depotBlocks: [] };
  const depotBuilds: { block: LayoutBlock; build: DepotBuild }[] = [];
  for (const b of layout.blocks) {
    if (b.kind === 'depot') depotBuilds.push({ block: b, build: fillDepot(ctx, b, env, out) });
    else fillBlock(ctx, b, env, out);
  }
  depotBuilds.sort((a, b) => depotBlocks.indexOf(a.block) - depotBlocks.indexOf(b.block));
  const { depots, pads, chargers } = assembleDepots(depotBuilds, GROUND_Y, terrain);

  // ---- no-fly zones -------------------------------------------------------------------------------------------
  const noFlyZones: NoFlyZone[] = [];
  const wantAuto = cfg.noFly.includes('auto');
  if (wantAuto) {
    noFlyZones.push(...out.noFly);
    const ap = airportNoFly(layout);
    if (ap) noFlyZones.push(ap);
  }
  cfg.noFly.forEach((spec, i) => {
    if (spec === 'auto') return;
    noFlyZones.push(zoneFromSpec(spec, i));
  });
  // depots must never sit inside a zone (even an inactive, closable one)
  for (const d of depots) {
    for (const p of [...d.handoff, d.pos]) {
      for (const z of noFlyZones) {
        if (inNoFlyZones([z], p.x, p.z, 3, false)) throw new Error(`depot ${d.id} overlaps no-fly zone ${z.id}`);
      }
    }
  }

  // ---- radio dead zones (no RNG: the main stream is untouched) ------------------------------------------------------
  const radioZones: RadioZone[] = [];
  if (cfg.radio) {
    if (cfg.radio.auto) radioZones.push(...generateRadioZones(layout.districts, ctx.buildings, out.cranes));
    cfg.radio.zones.forEach((spec, i) => radioZones.push(radioZoneFromSpec(spec, i)));
  }

  // ---- wind + shards --------------------------------------------------------------------------------------------
  const wind = generateWind(cfg.seed, bounds, cfg.wind, (x, z) => layout.isWater(x, z));
  const shards = createShardGrid(bounds, depots);
  for (const d of depots) d.catchmentShards = shards.ids.filter((id) => shards.depotOf[id] === d.id);

  // ---- public charging pads (own sites, no RNG; removed from the drop-site pool) -----------------------------------
  if ((cfg.publicPads ?? 0) > 0) {
    const pub = sitePublicPads(Math.min(8, Math.round(cfg.publicPads!)), ctx.groundSites, depots, noFlyZones);
    pads.push(...pub.pads);
    chargers.push(...pub.chargers);
    for (const g of pub.used) ctx.groundSites.splice(ctx.groundSites.indexOf(g), 1);
  }

  // ---- drop points ------------------------------------------------------------------------------------------------
  let landKm2 = 0;
  for (const d of layout.districts) if (d.kind !== 'water' && d.kind !== 'airport') landKm2 += ((d.maxX - d.minX) * (d.maxZ - d.minZ)) / 1e6;
  const { clusters, dropPoints } = generateDropPoints(plans, ctx, depots, noFlyZones, shards, { dropPointsPerKm2: cfg.dropPointsPerKm2, landKm2, groundY: GROUND_Y, rooftopOnly: cfg.rooftopOnly, terrain }, rng);

  // ---- streetscape ---------------------------------------------------------------------------------------------------
  const street = generateStreetscape(layout, ctx, rng, { coastal: (x, z) => x > layout.shoreX(z) - 450 });
  out.props.push(...street.props);

  // ---- power lines along the western ring motorway, turbines on the outskirts -----------------------------------------
  const powerLines: PowerLineData[] = [];
  const utilities: UtilityStructure[] = out.utilities.slice();
  const ring = layout.roads.find((r) => r.kind === 'motorway' && r.dir === 'NS' && r.c < layout.centre.x);
  if (f.powerLines && ring) {
    const ids: string[] = [];
    for (let z = ring.a + 80; z < ring.b - 80; z += 260) {
      const x = ring.c - ring.width / 2 - 26;
      if (layout.isWater(x, z) || (layout.airport && x > layout.airport.minX - 60 && x < layout.airport.maxX + 60 && z > layout.airport.minZ - 60 && z < layout.airport.maxZ + 60)) {
        if (ids.length >= 2) powerLines.push({ id: `PL-${powerLines.length + 1}`, pylonIds: ids.slice() });
        ids.length = 0;
        continue;
      }
      const id = `UT-PL-${utilities.length + 1}`;
      utilities.push({ id, kind: 'pylon', x, z, height: 38, radius: 2.2 });
      ids.push(id);
    }
    if (ids.length >= 2) powerLines.push({ id: `PL-${powerLines.length + 1}`, pylonIds: ids });
  }
  if (f.turbines > 0 && !layout.coast) {
    // no sea: a wind farm on open ground east of the centre (own RNG, so the main stream is untouched)
    const trng = new Rng(cfg.seed + 9101);
    for (let i = 0; i < f.turbines; i++) {
      const x = half * 0.55 + trng.range(-150, 150);
      const z = -half * 0.5 + (i * half) / f.turbines + trng.range(-80, 80);
      if (layout.isWater(x, z) || !ctx.clear(x, z, 60)) continue;
      utilities.push({ id: `UT-WT-${i + 1}`, kind: 'turbine', x, z, height: 70, radius: 3 });
      ctx.keepout(x, z, 60);
    }
  } else if (f.turbines > 0) {
    // a short line of coastal wind turbines on the headland south of the port
    const n = f.turbines;
    for (let i = 0; i < n; i++) {
      const z = half - 300 - i * 220;
      const x = layout.shoreX(z) - 140;
      if (layout.isWater(x, z) || !ctx.clear(x, z, 60)) continue;
      utilities.push({ id: `UT-WT-${i + 1}`, kind: 'turbine', x, z, height: 70, radius: 3 });
      ctx.keepout(x, z, 60);
    }
  }

  // ---- moving obstacles (balloons / blimps / helicopter) -------------------------------------------------------------
  const dynamicObstacles: DynamicObstacleDef[] = [];
  const nDyn = Math.max(2, Math.round(((cfg.size * cfg.size) / 1e6 / 2) * f.dynamicObstacleDensity));
  const parks = layout.districts.filter((d) => d.kind === 'park' || d.kind === 'cbd' || d.kind === 'commercial');
  for (let i = 0; i < nDyn; i++) {
    const kind: DynamicObstacleDef['kind'] = i % 3 === 0 ? 'blimp' : i % 3 === 1 ? 'balloon' : 'helicopter';
    const id = `DO-${String(i + 1).padStart(2, '0')}`;
    if (kind === 'balloon' && parks.length) {
      const d = rng.pick(parks);
      dynamicObstacles.push({ id, name: 'Survey balloon', kind, radius: 5, motion: { type: 'orbit', cx: (d.minX + d.maxX) / 2, cz: (d.minZ + d.maxZ) / 2, r: rng.range(60, 120), y: rng.range(34, 48) + terrain.maxY, speed: rng.range(3, 4.5), phase: rng.range(0, 6.28) } });
    } else {
      // patrol between two random land points
      let ax = 0;
      let az = 0;
      let bx = 0;
      let bz = 0;
      for (let k = 0; k < 20; k++) {
        ax = rng.range(bounds.minX + 300, bounds.maxX - 300);
        az = rng.range(bounds.minZ + 300, bounds.maxZ - 300);
        if (!layout.isWater(ax, az)) break;
      }
      for (let k = 0; k < 20; k++) {
        bx = rng.range(bounds.minX + 300, bounds.maxX - 300);
        bz = rng.range(bounds.minZ + 300, bounds.maxZ - 300);
        if (!layout.isWater(bx, bz) && Math.hypot(bx - ax, bz - az) > 500) break;
      }
      dynamicObstacles.push({ id, name: kind === 'blimp' ? 'Inspection blimp' : 'News helicopter', kind, radius: kind === 'blimp' ? 6 : 7, motion: { type: 'patrol', ax, az, bx, bz, y: (kind === 'blimp' ? rng.range(30, 40) : rng.range(50, 62)) + terrain.maxY, speed: kind === 'blimp' ? rng.range(3.5, 5) : rng.range(14, 20) } });
    }
  }

  // ---- obstacles + assembly ------------------------------------------------------------------------------------------
  const obstacles = buildObstacles(ctx.buildings, out.cranes, utilities, ctx.trees, (x, z) => heightAt(terrain, x, z));
  const world: WorldData = {
    seed: cfg.seed,
    size: cfg.size,
    bounds,
    rivers: layout.rivers,
    coast: layout.coast,
    openWater: !!mask,
    districts: layout.districts.map((d) => ({ id: d.id, kind: d.kind, name: d.name, minX: d.minX, maxX: d.maxX, minZ: d.minZ, maxZ: d.maxZ, centrality: d.centrality })),
    zones: layout.districts.map((d) => ({ id: `Z-${d.id}`, type: d.kind === 'cbd' || d.kind === 'commercial' ? 'commercial' : d.kind === 'industrial' || d.kind === 'logistics' || d.kind === 'port' ? 'industrial' : d.kind === 'park' || d.kind === 'cemetery' || d.kind === 'waterfront' ? 'park' : d.kind === 'farmland' ? 'rural' : d.kind === 'campus' || d.kind === 'hospital' || d.kind === 'stadium' ? 'civic' : d.kind === 'airport' ? 'transport' : d.kind === 'water' ? 'water' : 'residential', name: d.name, minX: d.minX, maxX: d.maxX, minZ: d.minZ, maxZ: d.maxZ })),
    roads: layout.roads,
    junctions: layout.junctions,
    rails: layout.rails,
    stations: layout.stations,
    blocks: out.blocks,
    buildings: ctx.buildings,
    trees: ctx.trees,
    streetlights: street.streetlights,
    equipment: ctx.equipment,
    balconies: ctx.balconies,
    vehicles: street.vehicles,
    containers: out.containers,
    parking: out.parking,
    props: out.props,
    loadingBays: out.loadingBays,
    cranes: out.cranes,
    utilities,
    powerLines,
    depots,
    pads,
    chargers,
    dropPoints,
    clusters,
    noFlyZones,
    radioZones,
    terrain,
    wind,
    shards,
    obstacles,
    dynamicObstacles,
    index: new Map(),
    stats: {},
  };
  const add = (type: string, list: { id: string }[]) => list.forEach((d) => world.index.set(d.id, { type, data: d }));
  add('district', world.districts);
  add('road', world.roads);
  add('block', world.blocks);
  add('building', world.buildings);
  add('depot', world.depots);
  add('pad', world.pads);
  add('charger', world.chargers);
  add('drop point', world.dropPoints);
  add('cluster', world.clusters);
  add('no-fly zone', world.noFlyZones);
  add('crane', world.cranes);
  add('utility', world.utilities);
  add('obstacle (dynamic)', world.dynamicObstacles);
  add('station', world.stations);
  add('tree', world.trees);
  world.stats = {
    size: cfg.size,
    districts: world.districts.length,
    roads: world.roads.length,
    blocks: world.blocks.length,
    buildings: world.buildings.length,
    trees: world.trees.length,
    depots: depots.length,
    pads: pads.length,
    dropPoints: dropPoints.length,
    clusters: clusters.length,
    noFlyZones: noFlyZones.length,
    shards: shards.ids.length,
    vehicles: world.vehicles.length,
    props: world.props.length,
    landKm2: Math.round(landKm2 * 100) / 100,
    ...(terrain.flat ? {} : { terrainMinY: Math.round(terrain.minY * 10) / 10, terrainMaxY: Math.round(terrain.maxY * 10) / 10 }),
  };
  void shardOf;
  return world;
}
