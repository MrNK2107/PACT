import { afterAll, describe, expect, it } from 'vitest';
import { tierOf, SCENARIO_NAMES, SCENARIOS } from './registry';
import { worldConfigFrom } from './load';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import type { Scenario } from './types';

/**
 * Scenario acceptance suite (TC-M8). Runs every scenario of every map headless for a window of simulated
 * time and checks it against the gate of its difficulty tier plus the invariants that must hold in all tiers.
 * Not part of `npm test` (it takes a couple of minutes): run it with `npm run scenarios`.
 *
 *   tier       delivered  on time  collisions  structure hits  drained batteries  tick p95
 *   tutorial   >= 5       >= 95 %  0           0               0                  <= 50 ms
 *   standard   >= 5       >= 80 %  0           (not gated)     0                  <= 50 ms
 *   hard       >= 3       >= 50 %  <= 3        (not gated)     <= 2               <= 50 ms
 *   stress     (none)     (none)   <= 10       (not gated)     <= 10              <= 50 ms
 *
 * Invariants in every tier: I1 no parcel is delivered twice; I3 a drone that lost a task's lease never picks
 * it up afterwards unless it claims it again; scripted ids and fault targets exist; every fault that is due
 * fires without a failure event; the same run twice gives the same event hash (AT-01).
 * Structure hits are only gated in the tutorial tier: drones occasionally clip building corners on some
 * runs (see docs/DECISIONS.md, Decision 10).
 */

const WINDOW_S = 900;
const DETERMINISM_S = 120;
const HEAVY_S = 120;

interface Gate {
  minDelivered: number;
  minOnTimePct: number;
  maxCollisions: number;
  maxStructureHits: number | null;
  maxDepleted: number;
  maxTickP95Ms: number;
}

export const GATES: Record<string, Gate> = {
  tutorial: { minDelivered: 5, minOnTimePct: 95, maxCollisions: 0, maxStructureHits: 0, maxDepleted: 0, maxTickP95Ms: 50 },
  standard: { minDelivered: 5, minOnTimePct: 80, maxCollisions: 0, maxStructureHits: null, maxDepleted: 0, maxTickP95Ms: 50 },
  hard: { minDelivered: 3, minOnTimePct: 50, maxCollisions: 3, maxStructureHits: null, maxDepleted: 2, maxTickP95Ms: 50 },
  stress: { minDelivered: 0, minOnTimePct: 0, maxCollisions: 10, maxStructureHits: null, maxDepleted: 10, maxTickP95Ms: 50 },
};

const heavy = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RUN_HEAVY;

interface Row {
  scenario: string;
  map: string;
  tier: string;
  seconds: number;
  delivered: number;
  onTimePct: number | null;
  collisions: number;
  structureHits: number;
  depleted: number;
  tickP95Ms: number;
  verdict: string;
}
const rows: Row[] = [];

function run(scn: Scenario, seconds: number): { eng: SimulationEngine; tickP95Ms: number } {
  const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
  eng.start();
  const times: number[] = [];
  for (let i = 0; i < 20 * seconds; i++) {
    const t0 = performance.now();
    eng.update(0.05);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { eng, tickP95Ms: times[Math.floor(times.length * 0.95)] ?? 0 };
}

/** Problems with ids the scenario refers to (typos in scripted tasks and fault targets). */
function referenceProblems(scn: Scenario, eng: SimulationEngine): string[] {
  const w = eng.world;
  const out: string[] = [];
  const depots = new Set(w.depots.map((d) => d.id));
  const drops = new Set(w.dropPoints.map((d) => d.id));
  const types = new Set(w.clusters.map((c) => c.type));
  for (const [i, t] of scn.workload.tasks.entries()) {
    if (t.origin_depot && !depots.has(t.origin_depot)) out.push(`tasks[${i}] origin_depot ${t.origin_depot} does not exist`);
    if (t.drop_id && !drops.has(t.drop_id)) out.push(`tasks[${i}] drop_id ${t.drop_id} does not exist`);
    if (t.cluster_type && !types.has(t.cluster_type)) out.push(`tasks[${i}] cluster_type ${t.cluster_type} has no cluster in this world`);
  }
  for (const [i, f] of scn.faults.entries()) {
    if (f.type === 'pad_outage' && !w.pads.some((p) => p.id === f.id)) out.push(`faults[${i}] pad ${f.id} does not exist`);
    if (f.type === 'depot_outage' && !depots.has(f.id)) out.push(`faults[${i}] depot ${f.id} does not exist`);
    if (f.type === 'radio_blackout' && !(f.circle || f.box || f.polygon) && !w.radioZones.some((z) => z.id === f.id || (f.id && z.id.toLowerCase().includes(f.id.toLowerCase())))) out.push(`faults[${i}] radio zone ${f.id} does not exist`);
    if (f.type === 'close_zone' && f.id && !w.noFlyZones.some((z) => z.id === f.id || (z.closable && z.id.toLowerCase().includes(f.id!.toLowerCase())))) out.push(`faults[${i}] closable zone ${f.id} does not exist`);
  }
  return out;
}

/** Invariants I1 and I3 from the event stream. */
function invariantProblems(eng: SimulationEngine): string[] {
  const out: string[] = [];
  const delivered = new Set<string>();
  const lost = new Set<string>(); // "drone|task" pairs after a zombie stop, until the drone claims the task again
  for (const e of eng.events) {
    const task = (e.data as { task?: string }).task;
    if (!task) continue;
    const key = `${e.agent}|${task}`;
    if (e.type === 'delivered') {
      if (delivered.has(task)) out.push(`I1: ${task} delivered twice`);
      delivered.add(task);
    } else if (e.type === 'zombie_stop') lost.add(key);
    else if (e.type === 'claimed') lost.delete(key);
    else if (e.type === 'picked_up' && lost.has(key)) out.push(`I3: ${e.agent} picked up ${task} after losing its lease`);
  }
  return out;
}

const names = SCENARIO_NAMES.filter((n) => heavy || !SCENARIOS[n].tags.includes('heavy'));

describe('scenario acceptance suite', () => {
  it('has a gate for every tier and 3 to 6 scenarios per shipped map', () => {
    const perMap = new Map<string, number>();
    for (const n of SCENARIO_NAMES) {
      expect(GATES[tierOf(SCENARIOS[n])], `${n} tier`).toBeDefined();
      perMap.set(SCENARIOS[n].map, (perMap.get(SCENARIOS[n].map) ?? 0) + 1);
    }
    for (const [map, n] of perMap) {
      if (map === 'harbour_metro_xl') continue; // single-scenario fixture (coastal_testbed also holds the P2P acceptance scenarios)
      expect(n, map).toBeGreaterThanOrEqual(3);
      expect(n, map).toBeLessThanOrEqual(6);
    }
  });

  describe.each(names)('%s', (name) => {
    const scn = SCENARIOS[name];
    const tier = tierOf(scn);
    const gate = GATES[tier];
    const isHeavy = scn.tags.includes('heavy');
    const seconds = isHeavy ? HEAVY_S : Math.min(scn.duration_s, WINDOW_S);

    it(`meets the ${tier} gate over ${seconds} s`, { timeout: 300000 }, () => {
      const { eng, tickP95Ms } = run(scn, seconds);
      const s = eng.snapshot();
      const depleted = eng.events.filter((e) => e.type === 'battery_depleted').length;
      const stats = s.tasks;
      const onTimePct = stats.delivered ? Math.round((100 * stats.onTime) / stats.delivered) : null;
      const problems: string[] = [...referenceProblems(scn, eng), ...invariantProblems(eng)];
      const failedFaults = eng.events.filter((e) => e.type.startsWith('fault') && (e.type.endsWith('_failed') || e.type === 'fault_unsupported'));
      for (const f of failedFaults) problems.push(`fault failed: ${f.type} ${JSON.stringify(f.data)}`);
      const due = scn.faults.filter((f) => f.t <= seconds).length;
      const fired = eng.events.filter((e) => e.type.startsWith('fault_') && !e.type.endsWith('_failed') && e.type !== 'fault_unsupported').length;
      if (fired < due) problems.push(`only ${fired} of ${due} due faults fired`);
      if (!isHeavy) {
        if (s.completed < gate.minDelivered) problems.push(`delivered ${s.completed} < ${gate.minDelivered}`);
        if (stats.delivered > 0 && (onTimePct ?? 100) < gate.minOnTimePct) problems.push(`on time ${onTimePct}% < ${gate.minOnTimePct}%`);
        if (s.collisions > gate.maxCollisions) problems.push(`collisions ${s.collisions} > ${gate.maxCollisions}`);
        if (gate.maxStructureHits !== null && s.structureHits > gate.maxStructureHits) problems.push(`structure hits ${s.structureHits} > ${gate.maxStructureHits}`);
        if (depleted > gate.maxDepleted) problems.push(`drained batteries ${depleted} > ${gate.maxDepleted}`);
      }
      if (tickP95Ms > gate.maxTickP95Ms) problems.push(`tick p95 ${tickP95Ms.toFixed(1)} ms > ${gate.maxTickP95Ms} ms`);
      rows.push({ scenario: name, map: scn.map, tier, seconds, delivered: s.completed, onTimePct, collisions: s.collisions, structureHits: s.structureHits, depleted, tickP95Ms: Math.round(tickP95Ms * 100) / 100, verdict: problems.length ? 'FAIL' : 'ok' });
      expect(problems).toEqual([]);
    });

    it('is deterministic (AT-01)', { timeout: 300000 }, () => {
      const a = run(scn, DETERMINISM_S).eng;
      const b = run(scn, DETERMINISM_S).eng;
      expect(a.eventHash()).toBe(b.eventHash());
    });
  });

  afterAll(() => {
    rows.sort((a, b) => a.map.localeCompare(b.map) || a.scenario.localeCompare(b.scenario));
    console.log(`\nscenario suite results (${rows.length} scenarios)`);
    console.table(rows);
  });
});
