import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import type { FaultDef } from '../scenario/types';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import { Rng } from '../world/rng';
import { assignComponentColours, COMPONENT_PALETTE, computeNetView, connectedComponents, droneNetInfo, messagesPerDroneMin, taskLedgerInfo } from './netGraph';

function engineWith(faults: FaultDef[] = [], over: object = {}): SimulationEngine {
  const scn = scenarioWith(getScenario('test_small'), { system: 'pact', fleet: { n_drones: 5 }, faults, ...over } as never);
  const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
  eng.start();
  return eng;
}

function step(eng: SimulationEngine, seconds: number, each?: () => void): void {
  for (let i = 0; i < 20 * seconds; i++) {
    eng.update(0.05);
    each?.();
  }
}

describe('connectedComponents', () => {
  it('roots each component at its smallest member id', () => {
    const c = connectedComponents(['d3', 'D1', 'd1', 'd2', 'd4'], [
      ['d3', 'd2'],
      ['d2', 'D1'],
      ['d4', 'd4'],
    ]);
    expect(c.get('d3')).toBe('D1');
    expect(c.get('d2')).toBe('D1');
    expect(c.get('D1')).toBe('D1');
    expect(c.get('d1')).toBe('d1');
    expect(c.get('d4')).toBe('d4');
  });

  it('ignores edges to unknown nodes', () => {
    const c = connectedComponents(['a', 'b'], [['a', 'zz']]);
    expect([...c.values()]).toEqual(['a', 'b']);
  });

  it('property: matches a BFS reference and does not depend on edge order', () => {
    const rng = new Rng(42);
    for (let trial = 0; trial < 200; trial++) {
      const n = 2 + Math.floor(rng.next() * 14);
      const ids = Array.from({ length: n }, (_, i) => `n${String(i).padStart(2, '0')}`);
      const edges: [string, string][] = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng.next() < 0.18) edges.push([ids[i], ids[j]]);
      // BFS reference
      const adj = new Map(ids.map((id) => [id, [] as string[]]));
      for (const [a, b] of edges) {
        adj.get(a)!.push(b);
        adj.get(b)!.push(a);
      }
      const ref = new Map<string, string>();
      for (const id of ids) {
        if (ref.has(id)) continue;
        const seen = [id];
        const q = [id];
        const mark = new Set(q);
        while (q.length) for (const nb of adj.get(q.shift()!)!) if (!mark.has(nb)) (mark.add(nb), q.push(nb), seen.push(nb));
        const root = [...seen].sort()[0];
        for (const s of seen) ref.set(s, root);
      }
      const shuffled = [...edges].reverse().map(([a, b]) => (rng.next() < 0.5 ? ([b, a] as [string, string]) : ([a, b] as [string, string])));
      expect(connectedComponents(ids, edges)).toEqual(ref);
      expect(connectedComponents(ids, shuffled)).toEqual(ref);
    }
  });
});

describe('assignComponentColours', () => {
  it('gives distinct colours while there are palette slots, independent of input order', () => {
    const roots = ['D1', 'd2', 'd5', 'd7'];
    const a = assignComponentColours(roots);
    const b = assignComponentColours([...roots].reverse());
    expect(a).toEqual(b);
    expect(new Set(a.values()).size).toBe(roots.length);
    for (const c of a.values()) expect(COMPONENT_PALETTE).toContain(c);
  });

  it('keeps a lone root on the same colour whatever else exists (no flicker on a heal)', () => {
    const alone = assignComponentColours(['D1']).get('D1');
    expect(assignComponentColours(['D1']).get('D1')).toBe(alone);
  });
});

describe('computeNetView (engine)', () => {
  it('one component in a healthy small world; depots are network nodes on their mast', () => {
    const eng = engineWith();
    step(eng, 5);
    const v = computeNetView(eng);
    expect(v.nodes.filter((n) => n.kind === 'depot').length).toBe(eng.world.depots.length);
    expect(v.nodes.filter((n) => n.kind === 'drone').length).toBe(eng.agents.length);
    const d0 = eng.world.depots[0];
    expect(v.nodes.find((n) => n.id === d0.id)!.pos.y).toBeCloseTo(d0.pos.y + 25);
    expect(v.components.length).toBe(1);
  });

  it('a scripted partition splits the graph into its groups and they merge again after the heal', () => {
    const probe = engineWith();
    const drones = probe.agents.map((a) => a.id).sort();
    const depots = probe.world.depots.map((d) => d.id).sort();
    const side = [drones[0], drones[1], depots[0]];
    const eng = engineWith([{ t: 5, type: 'partition', groups: [drones.slice(2).concat(depots.slice(1)), side], until: 20 }]);
    step(eng, 10);
    expect(eng.net.partitionGroups).not.toBeNull();
    expect(eng.net.partitionUntil).toBe(20);
    const v = computeNetView(eng);
    // no two-way link crosses the cut, so the two sides are in different components
    const rootA = new Set(side.map((id) => v.comp.get(id)));
    const rootB = new Set(drones.slice(2).concat(depots.slice(1)).map((id) => v.comp.get(id)));
    for (const r of rootA) expect(rootB.has(r)).toBe(false);
    expect(v.components.length).toBeGreaterThanOrEqual(2);
    for (const l of v.links) if (side.includes(l.a) !== side.includes(l.b)) throw new Error(`link across the cut ${l.a}-${l.b}`);
    step(eng, 15);
    expect(eng.net.partitionGroups).toBeNull();
    expect(computeNetView(eng).components.length).toBe(1);
  });

  it('a transmit-only link loss leaves the node with one-way links and its own component', () => {
    const probe = engineWith();
    const id = probe.agents.map((a) => a.id).sort()[0];
    const eng = engineWith([{ t: 2, type: 'link_loss', id, loss: 1, dir: 'tx', until: 50 }]);
    step(eng, 4);
    const v = computeNetView(eng);
    expect(v.comp.get(id)).toBe(id);
    expect(v.components.find((c) => c.root === id)!.members).toEqual([id]);
    const mine = v.links.filter((l) => l.a === id || l.b === id);
    for (const l of mine) expect(l.both).toBe(false);
  });
});

describe('viewer reads (engine)', () => {
  it('drone mode, quorum, ledger divergence and message rate are readable during a run', () => {
    const eng = engineWith();
    step(eng, 60);
    const info = droneNetInfo(eng, eng.agents[0].id)!;
    expect(info).not.toBeNull();
    expect(['CONNECTED', 'DEGRADED', 'PARTITIONED', 'SOLO']).toContain(info.mode);
    expect(info.reachable).toContain(eng.agents[0].id);
    expect(info.known.length).toBeGreaterThanOrEqual(1);
    const t = eng.board.tasks[0];
    const led = taskLedgerInfo(eng, t.task_id)!;
    expect(led.rec.task_id).toBe(t.task_id);
    expect(led.agree.length + led.behind.length + led.missing.length + led.ahead.length).toBe(eng.replicas().length);
    expect(led.ahead).toEqual([]);
    const mpm = messagesPerDroneMin(eng)!;
    expect(mpm).toBeGreaterThan(0);
  });

  it('reading every view each tick does not change the event log (hash unchanged)', () => {
    const faults: FaultDef[] = [];
    const quiet = engineWith(faults);
    step(quiet, 40);
    const watched = engineWith(faults);
    let k = 0;
    step(watched, 40, () => {
      computeNetView(watched);
      for (const a of watched.agents) droneNetInfo(watched, a.id);
      for (const t of watched.board.tasks) if (k++ % 7 === 0) taskLedgerInfo(watched, t.task_id);
      messagesPerDroneMin(watched);
    });
    expect(watched.eventHash()).toBe(quiet.eventHash());
  });
});
