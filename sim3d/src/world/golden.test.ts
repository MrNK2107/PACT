import { describe, expect, it } from 'vitest';
import { worldConfigFrom, scenarioWith } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from './buildWorld';
import { worldHash } from './worldHash';

/**
 * TC-M0 determinism lock. These pins were captured on the single-generator code before the maps
 * refactor; the legacy maps must keep generating byte-identical worlds (AT-01).
 */
const PINS: Record<string, string> = {
  test_small: '8c5100c8',
  s0_healthy: 'ef9c88d3',
  s10_scale: 'c9d57827',
};
const EVENT_PIN = '78b77dec';

describe('golden world hashes', () => {
  for (const name of ['test_small', 's0_healthy']) {
    it(`${name} world is unchanged`, () => {
      const w = createWorld(worldConfigFrom(getScenario(name)));
      expect(worldHash(w)).toBe(PINS[name]);
    });
  }
  it.skipIf(!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RUN_HEAVY)('s10_scale world is unchanged', () => {
    const w = createWorld(worldConfigFrom(getScenario('s10_scale')));
    expect(worldHash(w)).toBe(PINS.s10_scale);
  });
  it('test_small 300 s event log is unchanged', () => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 5 } });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * 300; i++) eng.update(0.05);
    expect(eng.eventHash()).toBe(EVENT_PIN);
  });
});
