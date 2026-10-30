import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import { compareLogs, deliveryCounts, hashLog, markersOf, nextIncident, parseEventLog, seekEngine, verifyRecording } from './replay';

const SCN = scenarioWith(getScenario('test_small'), {
  fleet: { n_drones: 4 },
  faults: [{ t: 40, type: 'kill_drone', id: 'A02' }],
});

function fresh(): SimulationEngine {
  return new SimulationEngine(createWorld(worldConfigFrom(SCN)), SCN);
}

function poses(e: SimulationEngine): string {
  return e.agents.map((a) => `${a.id}:${a.body.pos.x.toFixed(6)},${a.body.pos.y.toFixed(6)},${a.body.pos.z.toFixed(6)}`).join('|');
}

describe('replay viewer (TC-13)', () => {
  it('advanceTo matches the wall-clock driver step for step (AT-01)', () => {
    const a = fresh();
    a.start();
    for (let i = 0; i < 20 * 90; i++) a.update(0.05);
    const b = fresh();
    b.start();
    expect(b.advanceTo(90)).toBe(true);
    expect(b.time).toBeCloseTo(a.time, 9);
    expect(b.exportEventsJsonl()).toBe(a.exportEventsJsonl());
    expect(poses(b)).toBe(poses(a));
  });

  it('seeking back and forth reproduces the same run: log, hash and drone poses', async () => {
    const ref = fresh();
    ref.start();
    ref.advanceTo(120);
    const log = ref.exportEventsJsonl();
    const at120 = poses(ref);

    const e = fresh();
    await seekEngine(e, 120, undefined, 400);
    await seekEngine(e, 35, undefined, 400); // backwards: re-simulates from t = 0
    expect(e.time).toBeLessThan(36);
    expect(e.exportEventsJsonl()).toBe(log.split('\n').filter((l) => JSON.parse(l).t <= e.time + 1e-9).join('\n'));
    await seekEngine(e, 120, undefined, 400); // forwards: continues
    expect(e.exportEventsJsonl()).toBe(log);
    expect(e.eventHash()).toBe(ref.eventHash());
    expect(poses(e)).toBe(at120);
    expect(e.status).toBe('paused');
  });

  it('a recorded log parses, verifies against the re-simulation, and a tampered line is located', () => {
    const ref = fresh();
    ref.start();
    ref.advanceTo(60);
    const text = ref.exportEventsJsonl();
    const loaded = parseEventLog(`${text}\n`);
    expect(loaded.lines.length).toBe(ref.events.length);
    expect(loaded.scenario).toBe(SCN.name);
    expect(typeof loaded.seed).toBe('number');
    expect(hashLog(text)).toBe(ref.eventHash());

    const longer = fresh();
    longer.start();
    longer.advanceTo(90); // ran past the recording: only the recorded span is compared
    expect(compareLogs(loaded.lines, longer.exportEventsJsonl().split('\n'))).toEqual({ match: true, lines: loaded.lines.length });

    const k = Math.floor(loaded.lines.length / 2);
    const tampered = loaded.lines.slice();
    tampered[k] = tampered[k].replace(/"t":[0-9.]+/, '"t":0.001');
    const cmp = compareLogs(tampered, longer.exportEventsJsonl().split('\n'));
    expect(cmp.match).toBe(false);
    if (!cmp.match) expect(cmp.index).toBe(k);
  });

  it('verifyRecording accepts a recording cut at any time and rejects one from another seed', async () => {
    for (const cut of [17.3, 61, 133.05]) {
      const ref = fresh();
      ref.start();
      ref.advanceTo(cut);
      const log = parseEventLog(ref.exportEventsJsonl());
      const e = fresh();
      await seekEngine(e, 150, undefined, 500); // starts past the recording: verify restarts the run
      expect(await verifyRecording(e, log)).toEqual({ match: true, lines: log.lines.length });
    }
    const other = scenarioWith(SCN, { seed: SCN.seed + 1 });
    const o = new SimulationEngine(createWorld(worldConfigFrom(other)), other);
    o.start();
    o.advanceTo(60);
    expect((await verifyRecording(fresh(), parseEventLog(o.exportEventsJsonl()))).match).toBe(false);
  });

  it('deliveryCounts: distinct parcels, duplicates and deliveries after a time', () => {
    const ev = (t: number, task: string) => ({ t, agent: 'A01', type: 'delivered', data: { task } });
    const c = deliveryCounts([ev(10, 'J1'), ev(20, 'J2'), { t: 25, agent: null, type: 'fault', data: {} }, ev(30, 'J1'), ev(40, 'J3')], 25);
    expect(c).toEqual({ delivered: 3, duplicates: 1, after: 2 });
  });

  it('rejects text that is not an event log', () => {
    expect(() => parseEventLog('{"t":1,"type":"x"}\nnot json')).toThrow(/line 2/);
    expect(() => parseEventLog('{"hello":1}')).toThrow(/line 1/);
  });

  it('timeline markers include the injected fault and the drone failure, and next-incident skips deliveries', () => {
    const e = fresh();
    e.start();
    e.advanceTo(120);
    const m = markersOf(e.events);
    const fault = m.find((x) => x.kind === 'fault');
    expect(fault?.t).toBeCloseTo(40, 0);
    expect(fault?.label).toContain('kill_drone');
    expect(nextIncident(m, 0)?.t).toBeCloseTo(40, 0);
    for (let n = nextIncident(m, 0); n; n = nextIncident(m, n.t)) expect(n.kind).not.toBe('delivery');
  });
});
