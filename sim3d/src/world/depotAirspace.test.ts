import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenario/registry';
import { worldConfigFrom } from '../scenario/load';
import { createWorld } from './buildWorld';
import { blockInAirspace } from './Depots';
import type { LayoutBlock } from './CityLayout';
import { inNoFly } from './NoFly';
import { worldHash } from './worldHash';
import type { WorldData } from './types';

/** Every depot point (apron centre + hand-off points) is clear of every zone, closable or not, with the 3 m margin. */
function depotViolations(w: WorldData): string[] {
  const bad: string[] = [];
  for (const d of w.depots) {
    for (const p of [...d.handoff, d.pos]) {
      for (const z of w.noFlyZones) if (inNoFly([z], p.x, p.z, 3, false)) bad.push(`${d.id} in ${z.id}`);
    }
  }
  return bad;
}

describe('depot siting vs landmark airspace', () => {
  it('regression: dense_metro_core seed 31006 (dm_canyon_shadow) builds, and no depot sits under the stadium TFR', () => {
    // used to throw "depot D2 overlaps no-fly zone NFZ-STADIUM-BK-00209": the block next to the stadium was
    // a depot candidate, and the stadium's event circle reaches across the street
    const scn = { ...SCENARIOS.dm_canyon_shadow, seed: 31006 };
    const w = createWorld(worldConfigFrom(scn));
    expect(w.noFlyZones.some((z) => z.id === 'NFZ-STADIUM-BK-00209')).toBe(true);
    expect(depotViolations(w)).toEqual([]);
    expect(w.depots.length).toBe(4);
    // deterministic per seed
    expect(worldHash(createWorld(worldConfigFrom(scn)))).toBe(worldHash(w));
  });

  it('blockInAirspace counts the hand-off reach outside the block', () => {
    const b = { cx: 0, cz: 0, w: 100, d: 80 } as LayoutBlock;
    expect(blockInAirspace(b, [{ blockId: 'x', x: 0, z: 200, r: 100 }])).toBe(false);
    expect(blockInAirspace(b, [{ blockId: 'x', x: 0, z: 140, r: 100 }])).toBe(true); // 140 - 40 - 8 = 92 < 100
    expect(blockInAirspace(b, [{ blockId: 'x', x: 0, z: 150, r: 100 }])).toBe(false); // 102 >= 100
  });

  // Property: for every scenario and many seeds, generation never throws and no depot is in a no-fly zone.
  // The 12 km harbour_metro_xl map is skipped for run time (pinned by the golden hash). PACT_WORLD_SEEDS deepens it.
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const SEEDS = Number(env.PACT_WORLD_SEEDS ?? 6);
  it(`every scenario x ${SEEDS} seeds: no exception, no depot inside a no-fly zone`, () => {
    const seen = new Set<string>();
    const failures: string[] = [];
    for (const scn of Object.values(SCENARIOS)) {
      if (scn.map === 'harbour_metro_xl') continue;
      for (let i = 0; i < SEEDS; i++) {
        const seed = scn.seed + i;
        const cfg = worldConfigFrom({ ...scn, seed });
        const key = JSON.stringify(cfg);
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const bad = depotViolations(createWorld(cfg));
          if (bad.length) failures.push(`${scn.name}@${seed}: ${bad.join(', ')}`);
        } catch (e) {
          failures.push(`${scn.name}@${seed}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    expect(seen.size).toBeGreaterThan(20);
  }, 300_000);
});
