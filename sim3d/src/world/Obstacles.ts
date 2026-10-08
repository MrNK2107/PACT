import type { AABB, BuildingData, CraneData, StaticObstacle, TreeData, UtilityStructure } from './types';

function box(id: string, category: StaticObstacle['category'], b: AABB, name?: string): StaticObstacle {
  return { id, category, shape: 'box', bounds: b, cx: (b.minX + b.maxX) / 2, cz: (b.minZ + b.maxZ) / 2, r: 0, name };
}

function cyl(id: string, category: StaticObstacle['category'], cx: number, cz: number, r: number, y0: number, y1: number, name?: string): StaticObstacle {
  return { id, category, shape: 'cylinder', bounds: { minX: cx - r, maxX: cx + r, minY: y0, maxY: y1, minZ: cz - r, maxZ: cz + r }, cx, cz, r, name };
}

/** Collision volumes for the ObstacleManager / PathPlanner. Buildings share their bounds object. */
export function buildObstacles(buildings: BuildingData[], cranes: CraneData[], utilities: UtilityStructure[], trees: TreeData[]): StaticObstacle[] {
  const out: StaticObstacle[] = [];
  for (const b of buildings) out.push(box(b.id, 'building', b.bounds, b.name));
  for (const c of cranes) {
    if (c.kind === 'tower') {
      out.push(box(`${c.id}-MAST`, 'crane', { minX: c.x - 1.5, maxX: c.x + 1.5, minY: 0, maxY: c.mastHeight, minZ: c.z - 1.5, maxZ: c.z + 1.5 }, 'Tower crane mast'));
      out.push(cyl(`${c.id}-JIB`, 'crane', c.x, c.z, c.jibLength, c.mastHeight - 4, c.mastHeight + 4, 'Tower crane jib sweep'));
    } else if (c.kind === 'gantry') {
      const alongX = Math.abs(Math.cos(c.jibAngle)) > 0.5;
      for (const s of [-10, 10]) {
        const lx = alongX ? c.x + s : c.x;
        const lz = alongX ? c.z : c.z + s;
        out.push(box(`${c.id}-LEG${s > 0 ? 'B' : 'A'}`, 'crane', { minX: lx - 2, maxX: lx + 2, minY: 0, maxY: c.mastHeight, minZ: lz - 2, maxZ: lz + 2 }, 'Gantry crane leg'));
      }
      out.push(box(`${c.id}-BEAM`, 'crane', alongX ? { minX: c.x - 14, maxX: c.x + 14, minY: c.mastHeight - 4, maxY: c.mastHeight + 1, minZ: c.z - 3, maxZ: c.z + 3 } : { minX: c.x - 3, maxX: c.x + 3, minY: c.mastHeight - 4, maxY: c.mastHeight + 1, minZ: c.z - 14, maxZ: c.z + 14 }, 'Gantry crane beam'));
    } else {
      // quay crane: portal legs + boom cantilevered over the water (+x)
      out.push(box(`${c.id}-PORTAL`, 'crane', { minX: c.x - 8, maxX: c.x + 8, minY: 0, maxY: c.mastHeight, minZ: c.z - 8, maxZ: c.z + 8 }, 'Quay crane portal'));
      out.push(box(`${c.id}-BOOM`, 'crane', { minX: c.x - 8, maxX: c.x + c.jibLength, minY: c.mastHeight - 6, maxY: c.mastHeight + 6, minZ: c.z - 3, maxZ: c.z + 3 }, 'Quay crane boom'));
    }
  }
  for (const u of utilities) {
    if (u.kind === 'pylon' || u.kind === 'mast') out.push(box(u.id, 'utility', { minX: u.x - u.radius, maxX: u.x + u.radius, minY: 0, maxY: u.height, minZ: u.z - u.radius, maxZ: u.z + u.radius }, u.kind === 'pylon' ? 'Transmission pylon' : 'Mast'));
    else if (u.kind === 'turbine') out.push(cyl(u.id, 'utility', u.x, u.z, u.radius * 8, 0, u.height + u.radius * 8, 'Wind turbine rotor'));
    else out.push(cyl(u.id, 'utility', u.x, u.z, u.radius + (u.kind === 'watertower' ? 2 : 0), 0, u.height + (u.kind === 'watertower' ? 6 : 0), u.kind === 'tank' ? 'Storage tank' : u.kind === 'stack' ? 'Exhaust stack' : u.kind === 'silo' ? 'Silo' : 'Water tower'));
  }
  for (const t of trees) out.push(cyl(t.id, 'tree', t.x, t.z, t.radius, 0, t.height));
  return out;
}
