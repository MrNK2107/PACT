import { describe, expect, it } from 'vitest';
import type { Envelope, MessageType } from '../p2p/contracts';
import { loadScenario, parseScenarioYaml, scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { claimWaitFor, SIM } from '../sim/config';
import { RadioModel } from '../sim/Radio';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import type { RadioZone, Vec3 } from '../world/types';
import { Network, type NetworkConfig } from './Network';

const at = (x: number, y = 30, z = 0): Vec3 => ({ x, y, z });
const cfg = (over: Partial<NetworkConfig> = {}): NetworkConfig => ({ loss: 0, latencyMs: [50, 50], rangeM: 1000, seed: 1, ...over });

/** A network with fixed nodes at the given x positions. */
function netWith(nodes: Record<string, number>, over: Partial<NetworkConfig> = {}, radio?: RadioModel): Network {
  const net = new Network(cfg(over), radio);
  for (const [id, x] of Object.entries(nodes)) {
    const p = at(x);
    net.register(id, 'drone', () => p);
  }
  return net;
}

const send = (net: Network, src: string, type: MessageType = 'CLAIM', dst = '*', payload: unknown = { n: 0 }) => net.send({ type, src, dst, t_send: net.now, payload });

/** Steps the network in `dtS` increments up to `untilS`, collecting (arrival time, receiver, envelope). */
function drain(net: Network, ids: string[], fromS: number, untilS: number, dtS: number): { t: number; to: string; env: Envelope }[] {
  const out: { t: number; to: string; env: Envelope }[] = [];
  const n = Math.round((untilS - fromS) / dtS);
  for (let k = 1; k <= n; k++) {
    const t = fromS + k * dtS;
    net.step(t);
    for (const id of ids) for (const env of net.take(id)) out.push({ t, to: id, env });
  }
  return out;
}

describe('network: envelopes and delivery', () => {
  it('wraps payloads in v1 envelopes with per-sender seq and drops unknown fields', () => {
    const net = netWith({ A: 0, B: 10 });
    const e1 = net.send({ type: 'CLAIM', src: 'A', dst: '*', t_send: 3.5, payload: { x: 1 }, extra: 'ignored' } as Omit<Envelope, 'v' | 'seq'>);
    const e2 = send(net, 'A');
    const e3 = send(net, 'B');
    expect(e1).toEqual({ v: 1, type: 'CLAIM', src: 'A', dst: '*', seq: 1, t_send: 3.5, payload: { x: 1 } });
    expect([e2.seq, e3.seq]).toEqual([2, 1]);
    net.step(0.05);
    expect(net.take('B').map((e) => e.seq)).toEqual([1, 2]);
    expect(net.take('A').map((e) => e.src)).toEqual(['B']);
    expect(net.take('A')).toEqual([]); // taken once
  });

  it('delivers at the first step whose time >= send time + latency (beacons at the lower bound, no draw)', () => {
    const net = netWith({ A: 0, B: 10 }, { latencyMs: [50, 800] });
    send(net, 'A', 'HEARTBEAT');
    net.step(0.049);
    expect(net.take('B')).toEqual([]);
    net.step(0.05);
    expect(net.take('B')).toHaveLength(1);
    // the old one-tick bus is the special case latency = one tick
    const tick = netWith({ A: 0, B: 10 });
    tick.step(1);
    send(tick, 'A', 'HEARTBEAT');
    tick.step(1 + SIM.dt);
    expect(tick.take('B')).toHaveLength(1);
  });

  it('unicast reaches only its destination, and only when in range', () => {
    const net = netWith({ A: 0, B: 100, C: 200, FAR: 5000 });
    send(net, 'A', 'PICKUP_REQ', 'B');
    send(net, 'A', 'PICKUP_REQ', 'FAR');
    send(net, 'A', 'PICKUP_REQ', 'NOPE');
    net.step(1);
    expect(net.take('B')).toHaveLength(1);
    expect(net.take('C')).toEqual([]);
    expect(net.take('FAR')).toEqual([]);
  });

  it('cuts the range at range_m (scaled by dead zones)', () => {
    const net = netWith({ A: 0, IN: 99.9, OUT: 100.1 }, { rangeM: 100 });
    send(net, 'A');
    net.step(1);
    expect([net.take('IN').length, net.take('OUT').length]).toEqual([1, 0]);
    expect(net.linkUp('A', 'IN')).toBe(true);
    expect(net.linkUp('A', 'OUT')).toBe(false);
    const zone: RadioZone = { id: 'Z', name: 'z', shape: { type: 'circle', x: 0, z: 0, r: 20 }, rangeFactor: 0.5, lossAdd: 0, maxY: 70, active: true, source: 'scenario' };
    const zoned = netWith({ A: 0, IN: 49, OUT: 51 }, { rangeM: 100 }, new RadioModel([zone]));
    send(zoned, 'A');
    zoned.step(1);
    expect([zoned.take('IN').length, zoned.take('OUT').length]).toEqual([1, 0]);
  });

  it('orders a step by (deliverAt, sendSeq, receiver) and drops copies to a node that left', () => {
    const net = netWith({ A: 0, B: 10, C: 20, D: 30 });
    send(net, 'C', 'HEARTBEAT');
    send(net, 'A', 'HEARTBEAT');
    send(net, 'B', 'HEARTBEAT');
    net.unregister('D');
    net.step(1);
    expect(net.take('A').map((e) => e.src)).toEqual(['C', 'B']);
    expect(net.take('B').map((e) => e.src)).toEqual(['C', 'A']);
    // in flight to a node that leaves: dropped
    send(net, 'A', 'CLAIM');
    net.flush();
    expect(net.inFlight).toBe(2);
    net.unregister('B');
    expect(net.inFlight).toBe(1);
    expect(() => send(net, 'B')).toThrow(/not registered/);
    expect(() => net.register('A', 'drone', () => at(0))).toThrow(/already/);
  });

  it('take(accept) leaves the other envelopes queued; the port enforces the sender', () => {
    const net = netWith({ A: 0, B: 10 });
    send(net, 'A', 'HEARTBEAT');
    send(net, 'A', 'GOSSIP_DELTA');
    net.step(1);
    expect(net.take('B', (e) => e.type === 'HEARTBEAT').map((e) => e.type)).toEqual(['HEARTBEAT']);
    const port = net.port('B');
    expect(port.receive().map((e) => e.type)).toEqual(['GOSSIP_DELTA']);
    port.send({ type: 'PROBE', src: 'B', dst: 'A', t_send: 1, payload: { target: 'X' } });
    expect(() => port.send({ type: 'PROBE', src: 'A', dst: 'B', t_send: 1, payload: null })).toThrow(/cannot send as A/);
    net.step(2);
    expect(net.port('A').receive().map((e) => [e.type, e.src])).toEqual([['PROBE', 'B']]);
  });
});

describe('network: loss and latency statistics', () => {
  const N = 20000;

  it('measured loss matches network loss', () => {
    const net = netWith({ A: 0, B: 10 }, { loss: 0.3, seed: 11 });
    for (let i = 0; i < N; i++) send(net, 'A', 'HEARTBEAT');
    net.step(1);
    const rate = 1 - net.take('B').length / N;
    expect(Math.abs(rate - 0.3)).toBeLessThan(0.015);
    expect(net.stats('A').lost + net.stats('A').delivered).toBe(N);
  });

  it('loss combines network, dead-zone and link_loss tx/rx', () => {
    const zone: RadioZone = { id: 'Z', name: 'z', shape: { type: 'circle', x: 0, z: 0, r: 5 }, rangeFactor: 1, lossAdd: 0.25, maxY: 70, active: true, source: 'scenario' };
    const net = netWith({ A: 0, B: 10 }, { loss: 0.2, seed: 12 }, new RadioModel([zone]));
    net.setLinkLoss('A', 0.5, 'tx');
    net.setLinkLoss('B', 0.1, 'rx');
    for (let i = 0; i < N; i++) send(net, 'A', 'HEARTBEAT');
    net.step(1);
    const expected = 1 - 0.8 * 0.75 * 0.5 * 0.9;
    expect(Math.abs(1 - net.take('B').length / N - expected)).toBeLessThan(0.015);
  });

  it('queued traffic latency is U(lo, hi): mean, min and max', () => {
    const net = netWith({ A: 0, B: 10 }, { latencyMs: [50, 800], seed: 13 });
    const n = 5000;
    for (let i = 0; i < n; i++) send(net, 'A', 'GOSSIP_DELTA', '*', { i });
    const got = drain(net, ['B'], 0, 1, 0.001);
    expect(got).toHaveLength(n);
    const lat = got.map((g) => g.t * 1000);
    const mean = lat.reduce((a, b) => a + b, 0) / n;
    // delivery at the first 1 ms step at or after send + latency: measured latency is in [lat, lat + 1 ms]
    expect(Math.abs(mean - 425.5)).toBeLessThan(8);
    expect(Math.min(...lat)).toBeGreaterThanOrEqual(50);
    expect(Math.min(...lat)).toBeLessThan(55);
    expect(Math.max(...lat)).toBeLessThanOrEqual(801);
    expect(Math.max(...lat)).toBeGreaterThan(795);
    // arrival order is by latency, not by send order
    expect(got.map((g) => (g.env.payload as { i: number }).i)).not.toEqual([...Array(n).keys()]);
  });

  it('counts messages, copies and payload bytes per node and type', () => {
    const net = netWith({ A: 0, B: 10, C: 20 });
    send(net, 'A', 'CLAIM', '*', { task: 'T1' });
    send(net, 'A', 'HEARTBEAT', 'B', { p: 1 });
    net.step(1);
    const a = net.stats('A');
    expect(a.sent).toBe(2);
    expect(a.delivered).toBe(3);
    expect(a.bytesSent).toBe(JSON.stringify({ task: 'T1' }).length + JSON.stringify({ p: 1 }).length);
    expect(a.byType.CLAIM).toEqual({ sent: 1, bytes: 13, delivered: 2 });
    expect(net.stats('B').received).toBe(2);
    expect(net.totals().delivered).toBe(3);
    expect(net.allStats().map((s) => s.id)).toEqual(['A', 'B', 'C']);
  });
});

describe('network: partitions and asymmetric links', () => {
  it('a partition cuts links between groups until it heals; unlisted nodes join group 0', () => {
    const net = netWith({ A: 0, B: 10, C: 20, D: 30 });
    expect(net.partition([['A'], ['B', 'C']], 10)).toBe(true);
    net.step(1);
    send(net, 'A');
    send(net, 'B');
    net.step(2);
    expect(net.take('A').map((e) => e.src)).toEqual([]);
    expect(net.take('C').map((e) => e.src)).toEqual(['B']);
    expect(net.take('D').map((e) => e.src)).toEqual(['A']); // D unlisted -> group 0 with A
    expect(net.linkUp('A', 'B')).toBe(false);
    expect(net.step(10)).toEqual([{ kind: 'partition' }]);
    expect(net.partitionGroups).toBeNull();
    send(net, 'A');
    net.step(11);
    expect(['B', 'C', 'D'].map((id) => net.take(id).length)).toEqual([1, 1, 1]);
    expect(net.linkUp('A', 'B')).toBe(true);
  });

  it('the most recent partition wins; unknown ids are refused', () => {
    const net = netWith({ A: 0, B: 10, C: 20 });
    net.partition([['A'], ['B', 'C']], 100);
    net.partition([['A', 'B'], ['C']]);
    expect(net.linkUp('A', 'B')).toBe(true);
    expect(net.linkUp('B', 'C')).toBe(false);
    expect(net.partition([['A'], ['ZZ']])).toBe(false);
    expect(net.partitionGroups).toEqual([['A', 'B'], ['C']]);
    expect(net.step(1000)).toEqual([]); // open-ended
  });

  it('link_loss on tx silences a node that still hears; on rx the reverse; windows end', () => {
    const net = netWith({ A: 0, B: 10 });
    net.setLinkLoss('A', 1, 'tx', 5);
    send(net, 'A');
    send(net, 'B');
    net.step(1);
    expect([net.take('A').length, net.take('B').length]).toEqual([1, 0]);
    expect([net.linkUp('A', 'B'), net.linkUp('B', 'A')]).toEqual([false, true]);
    net.setLinkLoss('A', 1, 'rx', 5); // replaces the tx setting
    send(net, 'A');
    send(net, 'B');
    net.step(2);
    expect([net.take('A').length, net.take('B').length]).toEqual([0, 1]);
    expect(net.step(5)).toEqual([{ kind: 'link_loss', id: 'A' }]);
    send(net, 'B');
    net.step(6);
    expect(net.take('A')).toHaveLength(1);
    expect(net.setLinkLoss('NOPE')).toBe(false);
  });
});

describe('network: determinism', () => {
  const run = (seed: number) => {
    const net = netWith({ A: 0, B: 100, C: 200, D: 300 }, { loss: 0.2, latencyMs: [50, 800], seed });
    const log: string[] = [];
    for (let k = 1; k <= 400; k++) {
      const t = k * 0.05;
      net.step(t);
      for (const id of ['A', 'B', 'C', 'D']) for (const e of net.take(id)) log.push(`${t.toFixed(2)} ${id}<-${e.src}#${e.seq} ${e.type}`);
      for (const id of ['D', 'B', 'A', 'C']) send(net, id, k % 3 ? 'HEARTBEAT' : 'CLAIM');
      net.flush();
    }
    return log;
  };

  it('replays the same deliveries for the same seed, and differs for another', () => {
    const a = run(5);
    expect(run(5)).toEqual(a);
    expect(run(6)).not.toEqual(a);
    expect(a.length).toBeGreaterThan(1000);
  });
});

describe('network in the engine', () => {
  const engine = (faults: object[], over: object = {}) => {
    const scn = scenarioWith(getScenario('test_small'), { fleet: { n_drones: 3 }, faults, ...over } as never);
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    return eng;
  };
  const runTo = (eng: SimulationEngine, t: number) => {
    while (eng.time < t - 1e-9) eng.update(0.05);
  };

  it('registers drones and depots (on a mast); drones hear each other through it', () => {
    const eng = engine([]);
    const depot = eng.world.depots[0];
    expect(eng.net.ids()).toEqual([...eng.agents.map((a) => a.id), ...eng.world.depots.map((d) => d.id)].sort());
    expect(eng.net.kindOf(depot.id)).toBe('depot');
    runTo(eng, 5);
    expect(eng.agents.some((a) => a.controller.neighborCount > 0)).toBe(true);
    expect(eng.net.stats('A01').byType.HEARTBEAT!.sent).toBeGreaterThan(40);
    // under pact the depot is a P2P node: it gossips (deltas, digests) but never beacons or bids
    const dep = eng.net.stats(depot.id);
    expect(dep.sent).toBeGreaterThan(0);
    expect(dep.byType.HEARTBEAT).toBeUndefined();
    expect(dep.byType.CLAIM).toBeUndefined();
    expect(dep.received).toBeGreaterThan(0);
  });

  it('partition, link_loss and clock_drift faults fire, end and reset; unknown ids fail', () => {
    const eng = engine([
      { t: 2, type: 'partition', groups: [['A01'], ['A02', 'A03']], until: 6 },
      { t: 3, type: 'link_loss', id: 'A02', dir: 'tx', until: 5 },
      { t: 3, type: 'link_loss', id: 'A99' },
      { t: 4, type: 'clock_drift', id: 'A03', ppm: 10000 },
      { t: 4, type: 'clock_drift', id: 'A98', ppm: 10 },
      { t: 4, type: 'partition', groups: [['A01'], ['A97']], until: 5 },
    ]);
    runTo(eng, 2.5);
    expect(eng.net.linkUp('A01', 'A02')).toBe(false);
    runTo(eng, 4.5);
    expect(eng.net.linkUp('A02', 'A03')).toBe(false);
    expect(eng.net.linkUp('A03', 'A02')).toBe(true);
    runTo(eng, 10);
    const types = eng.events.filter((e) => /partition|link_loss|clock_drift/.test(e.type)).map((e) => `${e.t.toFixed(1)} ${e.type}`);
    expect(types).toEqual(['2.0 fault_partition', '3.0 fault_link_loss', '3.0 fault_link_loss_failed', '4.0 fault_clock_drift', '4.0 fault_clock_drift_failed', '4.0 fault_partition_failed', '5.0 link_loss_end', '6.0 partition_end']);
    expect(eng.events.some((e) => e.type === 'fault_unsupported')).toBe(false);
    expect(eng.net.linkUp('A01', 'A02')).toBe(true);
    // A03's clock: continuous at the fault tick, 1 % fast after
    const t0 = eng.events.find((e) => e.type === 'fault_clock_drift')!.t;
    const c = eng.clockOf('A03')!;
    expect(c.nowLocal()).toBeCloseTo(t0 + (eng.time - t0) * 1.01, 9);
    expect(eng.clockOf('A01')!.nowLocal()).toBeCloseTo(eng.time, 9);
    eng.reset();
    expect(eng.clockOf('A03')!.ppm).toBe(0);
    expect(eng.net.partitionGroups).toBeNull();
    expect(eng.net.stats('A01').sent).toBe(0);
  });

  it('a kill_drone unregisters the node and its clock', () => {
    const eng = engine([{ t: 1, type: 'kill_drone', id: 'A02' }]);
    runTo(eng, 2);
    expect(eng.net.has('A02')).toBe(false);
    expect(eng.clockOf('A02')).toBeUndefined();
  });

  it('network draws never perturb the workload stream', () => {
    const created = (loss: number) => {
      const eng = engine([], { network: { loss } });
      runTo(eng, 120);
      return eng.events.filter((e) => e.type === 'task_created').map((e) => JSON.stringify(e));
    };
    const a = created(0);
    expect(a.length).toBeGreaterThan(5);
    expect(created(0.4)).toEqual(a);
  });

  it('a partitioned run is deterministic', () => {
    const run = () => {
      const eng = engine([{ t: 10, type: 'partition', groups: [['A01'], ['A02', 'A03']], until: 60 }], { network: { loss: 0.1 } });
      runTo(eng, 90);
      return eng.eventHash();
    };
    expect(run()).toBe(run());
  });
});

describe('claim window vs latency', () => {
  it('stretches the claim window to cover the latency upper bound plus a tick', () => {
    expect(claimWaitFor([50, 800])).toBeCloseTo(0.8 + SIM.dt, 9);
    expect(claimWaitFor([0, 100])).toBe(SIM.claimWindow);
    const scn = scenarioWith(getScenario('test_small'), { network: { latency_ms: [10, 1200] } });
    new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    expect(SIM.claimWait).toBeCloseTo(1.25, 9);
  });
});

describe('network fault validation', () => {
  const load = (y: string) => () => loadScenario(parseScenarioYaml(y, 'n.yaml'), 'n.yaml');
  it('rejects malformed network faults and latency', () => {
    expect(load('faults: [{ t: 5, type: partition, groups: [[A01]] }]')).toThrow(/at least 2/);
    expect(load('faults: [{ t: 5, type: partition, groups: [[A01], [A01]] }]')).toThrow(/more than one group/);
    expect(load('faults: [{ t: 5, type: link_loss }]')).toThrow(/needs the id/);
    expect(load('faults: [{ t: 5, type: link_loss, id: A01, dir: up }]')).toThrow(/dir/);
    expect(load('faults: [{ t: 5, type: link_loss, id: A01, loss: 2 }]')).toThrow(/loss/);
    expect(load('faults: [{ t: 5, type: clock_drift, id: A01, ppm: 2000000 }]')).toThrow(/ppm/);
    expect(load('network: { latency_ms: [500, 100] }')).toThrow(/latency_ms\[1\]/);
    expect(load('faults: [{ t: 5, type: link_loss, id: A01, dir: rx, loss: 0.5, until: 9 }, { t: 6, type: clock_drift, id: D1, ppm: -50 }]')).not.toThrow();
  });
});

describe('network: depot backhaul (Decision 20)', () => {
  const BH = { enabled: true, latencyMs: [10, 40] as [number, number], loss: 0 };
  /** Depots far beyond radio range of each other (5 km apart, range 1 km), plus a drone next to D1. */
  function bhNet(over: Partial<NetworkConfig> = {}): Network {
    const net = new Network(cfg({ latencyMs: [50, 800], backhaul: BH, ...over }));
    const pos: Record<string, Vec3> = { D1: at(0), D2: at(5000), D3: at(-5000), A01: at(100) };
    for (const id of ['D1', 'D2', 'D3']) net.register(id, 'depot', () => pos[id]);
    net.register('A01', 'drone', () => pos.A01);
    return net;
  }

  it('delivers depot to depot regardless of distance and radio zones; drones never use it', () => {
    const net = bhNet();
    send(net, 'D1');
    send(net, 'A01');
    const got = drain(net, ['D1', 'D2', 'D3', 'A01'], 0, 2, 0.05);
    expect(got.filter((g) => g.env.src === 'D1').map((g) => g.to).sort()).toEqual(['A01', 'D2', 'D3']);
    expect(got.filter((g) => g.env.src === 'A01').map((g) => g.to)).toEqual(['D1']); // radio only
    expect(net.backhaulStats('D1')).toMatchObject({ copies: 2, delivered: 2 });
    expect(net.backhaulStats('A01').copies).toBe(0);
    expect(net.linkUp('D1', 'D2')).toBe(true);
    expect(net.linkUp('A01', 'D2')).toBe(false);
  });

  it('latency within [lo, hi] and loss at the configured rate', () => {
    const net = bhNet({ backhaul: { ...BH, loss: 0.2 } });
    const lat: number[] = [];
    let sent = 0;
    for (let k = 0; k < 2000; k++) {
      const t0 = net.now;
      send(net, 'D1', 'GOSSIP_DELTA', 'D2');
      sent++;
      for (const g of drain(net, ['D2'], t0, t0 + 0.05, 0.005)) lat.push((g.t - t0) * 1000);
    }
    const lossRate = 1 - lat.length / sent;
    expect(lossRate).toBeGreaterThan(0.17);
    expect(lossRate).toBeLessThan(0.23);
    expect(Math.min(...lat)).toBeGreaterThanOrEqual(10 - 1e-6);
    expect(Math.max(...lat)).toBeLessThanOrEqual(40 + 5 + 1e-6); // + one drain step
    const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
    expect(mean).toBeGreaterThan(22);
    expect(mean).toBeLessThan(33);
  });

  it('a partition with the depots in different groups cuts it; depots in one group keep it; link_loss does not touch it', () => {
    const net = bhNet();
    net.setLinkLoss('D1', 1, 'both');
    net.partition([['D1', 'D2', 'A01'], ['D3']], 1);
    send(net, 'D1');
    const got = drain(net, ['D2', 'D3', 'A01'], 0, 0.5, 0.05);
    expect(got.map((g) => g.to)).toEqual(['D2']); // backhaul to D2 despite D1's radio link loss; D3 cut; A01 radio-lost
    expect(net.linkUp('D1', 'D3')).toBe(false);
    drain(net, [], 0.5, 1.05, 0.05); // partition ends at 1 s
    expect(net.linkUp('D1', 'D3')).toBe(true);
  });

  it('backhaul_cut takes it down (radio fallback in range only) and it is restored after until', () => {
    const net = bhNet();
    expect(net.cutBackhaul(['D2'], 1)).toEqual(['D2']);
    expect(net.cutBackhaul(['A01'])).toBeNull();
    send(net, 'D1');
    let got = drain(net, ['D2', 'D3'], 0, 0.5, 0.05);
    expect(got.map((g) => g.to)).toEqual(['D3']);
    const ends = net.advance(1);
    expect(ends).toContainEqual({ kind: 'backhaul_cut', depots: ['D2'] });
    send(net, 'D1');
    got = drain(net, ['D2', 'D3'], 1, 1.5, 0.05);
    expect(got.map((g) => g.to).sort()).toEqual(['D2', 'D3']);
    expect(net.cutBackhaul(undefined)).toEqual(['D1', 'D2', 'D3']);
    expect(net.backhaulUp('D1', 'D3')).toBe(false);
  });

  it('disabled: depots only reach each other by radio', () => {
    const net = bhNet({ backhaul: { ...BH, enabled: false } });
    send(net, 'D1');
    expect(drain(net, ['D2', 'D3'], 0, 2, 0.05)).toEqual([]);
  });

  it('scenario: defaults on, validated, backhaul_cut fault parsed', () => {
    const load = (y: string) => () => loadScenario(parseScenarioYaml(y, 'n.yaml'), 'n.yaml');
    expect(load('name: x')().network.backhaul).toEqual({ enabled: true, latency_ms: [10, 40], loss: 0 });
    expect(load('network: { backhaul: { enabled: maybe } }')).toThrow(/enabled/);
    expect(load('network: { backhaul: { loss: 2 } }')).toThrow(/backhaul.loss/);
    expect(load('network: { backhaul: { latency_ms: [40, 10] } }')).toThrow(/backhaul.latency_ms/);
    expect(load('faults: [{ t: 5, type: backhaul_cut, depots: D1 }]')).toThrow(/depots/);
    expect(load('faults: [{ t: 5, type: backhaul_cut, until: 50 }, { t: 6, type: backhaul_cut, depots: [D1] }]')).not.toThrow();
  });

  it('engine: backhaul_cut fires, and backhaul_restored is logged at until', () => {
    const scn = scenarioWith(getScenario('test_small'), { faults: [{ t: 10, type: 'backhaul_cut', until: 20 }] } as never);
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * 25; i++) eng.update(0.05);
    expect(eng.events.some((e) => e.type === 'fault_backhaul_cut')).toBe(true);
    const r = eng.events.find((e) => e.type === 'backhaul_restored');
    expect(r?.t).toBeCloseTo(20, 1);
  });
});
