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
/**
 * Event-log pins (re-pinned for the P2P integration: under pact the drones run on their own replicas and gossip over
 * the network, and the yield sidestep of computeAvoidance changed; world hashes are untouched).
 * History of the default run: '71fafa16' (TC-02 network model, shared board); 'a4db0c1b' (P2P integration).
 * Re-pinned for Decision 19 ('9a26c94f': QUORUM counts the configured fleet roster) and Decision 20 (depot backhaul,
 * 10-40 ms; the fixed-latency pin below is unchanged because both latencies land on the next 50 ms tick).
 */
const EVENT_PIN = '983db908';

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
  it('a fixed-latency (50 ms) lossless run is unchanged', () => {
    // TC-02 checked here that the network model reproduced the old one-tick MessageBus exactly (pin '78b77dec', shared
    // board). Since the P2P integration pact traffic is gossip on that network, so this is now a plain regression pin.
    // Re-pinned from 'b135805e' for the TC-09 hardening's holder sidestep in computeAvoidance (world hashes unchanged),
    // then from '840ddd65' for Decision 19 (QUORUM over the fleet roster).
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 5 }, network: { latency_ms: [50, 50] } });
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * 300; i++) eng.update(0.05);
    expect(eng.eventHash()).toBe('11cc8b6e');
  });
});
