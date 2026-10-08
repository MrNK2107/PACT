import type { CityLayout, LayoutBlock } from './CityLayout';
import type { Rng } from './rng';

/**
 * One-of-a-kind landmarks that give the city a recognisable silhouette. They are assigned to blocks
 * before the fillers run (the block `kind` is simply pre-set), so the fillers treat them like any
 * other kind. Also marks 2–3 "old town" districts near the river mouth with denser, older character.
 */
export function placeLandmarks(layout: CityLayout, rng: Rng): { oldTown: Set<string> } {
  const free = (b: LayoutBlock) => !b.kind && !b.nearWater;
  const dist = (b: LayoutBlock, x: number, z: number) => Math.hypot(b.cx - x, b.cz - z);
  const pick = (cands: LayoutBlock[], kind: string) => {
    if (!cands.length) return null;
    cands[0].kind = kind;
    return cands[0];
  };

  // tallest tower: largest cbd/commercial block nearest the centre
  pick(
    layout.blocks.filter((b) => free(b) && (b.district === 'cbd' || b.district === 'commercial') && b.w >= 60 && b.d >= 60).sort((a, b) => dist(a, layout.centre.x, layout.centre.z) - dist(b, layout.centre.x, layout.centre.z)),
    'landmarktower',
  );

  // old town: the 2–3 non-water residential/mixed districts closest to the river mouth
  const oldTown = new Set<string>();
  const river = layout.rivers[0];
  const mouth = river.points[river.points.length - 1];
  const cands = layout.districts
    .filter((d) => ['mixed', 'townhouses', 'apartments', 'houses'].includes(d.kind) && d.waterFrac === 0)
    .sort((a, b) => Math.hypot((a.minX + a.maxX) / 2 - mouth.x, (a.minZ + a.maxZ) / 2 - mouth.z) - Math.hypot((b.minX + b.maxX) / 2 - mouth.x, (b.minZ + b.maxZ) / 2 - mouth.z));
  for (const d of cands.slice(0, layout.size >= 8000 ? 3 : 2)) oldTown.add(d.id);

  // cathedral in the old town (largest free block there)
  pick(
    layout.blocks.filter((b) => free(b) && oldTown.has(b.districtId) && b.w >= 60 && b.d >= 50).sort((a, b) => b.w * b.d - a.w * a.d),
    'cathedral',
  );

  // broadcast mast on the outskirts
  pick(
    layout.blocks.filter((b) => free(b) && (b.district === 'suburb' || b.district === 'houses') && b.w >= 60 && b.d >= 50 && b.centrality < 0.15).sort((a, b) => a.centrality - b.centrality),
    'tvmast',
  );

  // gasometer in an industrial estate
  const ind = layout.blocks.filter((b) => free(b) && b.district === 'industrial' && Math.min(b.w, b.d) >= 70);
  if (ind.length) pick([ind[rng.int(0, ind.length - 1)]], 'gasometer');

  return { oldTown };
}
