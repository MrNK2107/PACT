import { afterAll, describe, expect, it } from 'vitest';
import { P2P_DEFAULTS } from '../p2p/contracts';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import { computeMetrics } from '../eval/metrics';
import { backhaulLoad } from '../eval/bench';
import { scenarioWith, worldConfigFrom } from './load';
import { SCENARIOS } from './registry';
import type { FaultDef, Scenario } from './types';

/**
 * P2P acceptance tests (PRD section 11: AT-03, AT-04, AT-06, AT-09, AT-10, AT-11) as machine checks over the
 * acceptance scenarios in scenarios/coastal_testbed/at*.yaml (and s10_scale for AT-11). Run by `npm run scenarios`
 * next to the per-tier suite. Every check reads the structured event log only (plus replica sampling for I2).
 * Simulation results only.
 */

interface Run {
  eng: SimulationEngine;
  tickP95Ms: number;
  /** I2: a replica whose epoch for a task went down between two ticks. */
  epochDrops: string[];
}

function run(scn: Scenario, seconds: number, sampleI2 = false): Run {
  const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
  eng.start();
  const times: number[] = [];
  const seen = new Map<string, number>();
  const epochDrops: string[] = [];
  for (let i = 0; i < 20 * seconds; i++) {
    const t0 = performance.now();
    eng.update(0.05);
    times.push(performance.now() - t0);
    if (!sampleI2 || i % 10) continue;
    for (const { id, replica } of eng.replicas()) {
      for (const rec of replica.tasks()) {
        const k = `${id}|${rec.task_id}`;
        const prev = seen.get(k);
        if (prev !== undefined && rec.epoch < prev) epochDrops.push(`${k} ${prev} -> ${rec.epoch} at ${eng.time.toFixed(2)}`);
        seen.set(k, rec.epoch);
      }
    }
  }
  times.sort((a, b) => a - b);
  return { eng, tickP95Ms: times[Math.floor(times.length * 0.95)] ?? 0, epochDrops };
}

type Ev = SimulationEngine['events'][number];
const taskOf = (e: Ev) => (e.data as { task?: string }).task;

/** I1 (no task delivered twice) and I3 (no pickup after the drone's own zombie-stop without a new claim). */
function invariantProblems(events: readonly Ev[]): string[] {
  const out: string[] = [];
  const delivered = new Set<string>();
  const lost = new Set<string>();
  for (const e of events) {
    const task = taskOf(e);
    if (!task) continue;
    const key = `${e.agent}|${task}`;
    if (e.type === 'delivered') {
      if (delivered.has(task)) out.push(`I1: ${task} delivered twice`);
      delivered.add(task);
    } else if (e.type === 'zombie_stop') lost.add(key);
    else if (e.type === 'claimed') lost.delete(key);
    else if (e.type === 'picked_up' && lost.has(key)) out.push(`I3: ${e.agent} picked up ${task} after its zombie-stop`);
  }
  return out;
}

function fired(events: readonly Ev[], type: string): Ev[] {
  return events.filter((e) => e.type === `fault_${type}` || (e.type === 'fault' && (e.data as { type?: string }).type === type));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const report: { at: string; result: string }[] = [];

describe('P2P acceptance (PRD section 11)', () => {
  it('AT-03 split-brain, STRICT: 5 min partition, >= 20 jobs during it, 0 duplicate deliveries, I1 / I2 / I3 hold', () => {
    const scn = SCENARIOS['at03_split_brain_strict'];
    expect(scn.policy.partition).toBe('STRICT');
    const part = scn.faults.find((f): f is Extract<FaultDef, { type: 'partition' }> => f.type === 'partition')!;
    expect(part.until! - part.t).toBeGreaterThanOrEqual(300);
    const { eng, epochDrops } = run(scn, scn.duration_s, true);
    const ev = eng.events;
    expect(ev.some((e) => e.type === 'fault_partition')).toBe(true);
    expect(ev.some((e) => e.type === 'partition_end')).toBe(true);
    const jobs = ev.filter((e) => e.type === 'task_created' && e.t >= part.t && e.t < part.until!).length;
    const m = computeMetrics(ev, scn.duration_s);
    const minority = new Set(part.groups[0]);
    const claimsDuring = (side: boolean) => ev.filter((e) => e.type === 'claimed' && e.t >= part.t && e.t < part.until! && minority.has(e.agent ?? '') === side).length;
    report.push({ at: 'AT-03', result: `${jobs} jobs during the 300 s partition; claims during it: D1 side ${claimsDuring(true)}, other side ${claimsDuring(false)}; delivered ${m.delivered}; duplicate deliveries ${m.duplicateDeliveries}; zombie pickups ${m.zombiePickups}; refusals ${m.depotRefusals}` });
    expect(jobs).toBeGreaterThanOrEqual(20);
    expect(m.duplicateDeliveries).toBe(0);
    expect(invariantProblems(ev)).toEqual([]);
    expect(epochDrops).toEqual([]);
  });

  it('AT-04 zombie stop: the isolated owner stops before its depot re-opens; a new owner claims; the old one never picks up', () => {
    const scn = SCENARIOS['at04_zombie_stop'];
    const f = scn.faults.find((x): x is Extract<FaultDef, { type: 'link_loss' }> => x.type === 'link_loss')!;
    const { eng } = run(scn, 400);
    const ev = eng.events;
    expect(fired(ev, 'link_loss').length).toBeGreaterThan(0);
    // premise: the isolated drone held a pre-pickup lease when its link went down
    const held = ev.filter((e) => e.type === 'claimed' && e.agent === f.id && e.t < f.t).map(taskOf).filter((t): t is string => !!t);
    const task = held.filter((t) => !ev.some((e) => (e.type === 'picked_up' || e.type === 'delivered' || e.type === 'zombie_stop') && taskOf(e) === t && e.t < f.t)).pop();
    expect(task, `${f.id} held a pre-pickup task at ${f.t} s`).toBeDefined();
    const zs = ev.find((e) => e.type === 'zombie_stop' && e.agent === f.id && taskOf(e) === task && e.t >= f.t);
    const reopen = ev.find((e) => e.type === 'lease_expired' && taskOf(e) === task && e.t >= f.t);
    expect(zs, 'old owner zombie-stops').toBeDefined();
    expect(reopen, 'origin depot re-opens').toBeDefined();
    expect((reopen!.data as { node?: string }).node).toBe(task!.split(':')[0]);
    expect(reopen!.t).toBeGreaterThan(zs!.t);
    const next = ev.find((e) => e.type === 'claimed' && taskOf(e) === task && e.t > reopen!.t);
    expect(next, 'a new owner claims').toBeDefined();
    expect(next!.agent).not.toBe(f.id);
    expect(ev.filter((e) => e.type === 'picked_up' && taskOf(e) === task && e.agent === f.id)).toEqual([]);
    expect(invariantProblems(ev)).toEqual([]);
    const pick = ev.find((e) => e.type === 'picked_up' && taskOf(e) === task);
    report.push({ at: 'AT-04', result: `${f.id} isolated at ${f.t} s holding ${task}; zombie_stop +${(zs!.t - f.t).toFixed(1)} s; re-opened by ${(reopen!.data as { node: string }).node} +${(reopen!.t - f.t).toFixed(1)} s (${(reopen!.t - zs!.t).toFixed(1)} s after the stop); new owner ${next!.agent} +${(next!.t - f.t).toFixed(1)} s${pick ? `, picked up by ${pick.agent}` : ''}; old owner picked up: never` });
  });

  it('AT-06 drone failure: replacement only after DECLARED_FAILED, exactly one; recovery median <= 30 s over 8 seeds', () => {
    const scn = SCENARIOS['at06_drone_failure'];
    // the scenario file's own kill (base seed): the victim is a carrier
    const kill = scn.faults.find((x): x is Extract<FaultDef, { type: 'kill_drone' }> => x.type === 'kill_drone')!;
    const base = run(scn, kill.t + 200).eng;
    expect(base.events.some((e) => e.type === 'drone_lost_in_flight' && e.agent === kill.id), 'scenario kill hits a carrier').toBe(true);
    // the same rule over 8 seeds: kill whoever made the first pickup after 120 s, 10 s after it (Decision 18 measure)
    const rec: number[] = [];
    const rows: string[] = [];
    for (let i = 0; i < 8; i++) {
      const seed = scn.seed + i;
      const probe = run(scenarioWith(scn, { seed, faults: [] } as never), 330).eng;
      const pick = probe.events.find((e) => e.type === 'picked_up' && e.t > 120);
      expect(pick, `seed ${seed}: a pickup after 120 s`).toBeDefined();
      const victim = pick!.agent!;
      const task = taskOf(pick!)!;
      const depot = task.split(':')[0];
      const tKill = Math.round((pick!.t + 10) * 20) / 20;
      const ev = run(scenarioWith(scn, { seed, faults: [{ t: tKill, type: 'kill_drone', id: victim }] } as never), tKill + 200).eng.events;
      expect(ev.some((e) => e.type === 'drone_lost_in_flight' && e.agent === victim), `seed ${seed}: carrier killed in flight`).toBe(true);
      const decl = ev.find((e) => e.type === 'peer_failed' && (e.data as { node?: string }).node === depot && (e.data as { peer?: string }).peer === victim);
      expect(decl, `seed ${seed}: origin depot declares ${victim} failed`).toBeDefined();
      const re = ev.filter((e) => e.type === 'task_reordered' && (e.data as { of?: string }).of === task);
      expect(re, `seed ${seed}: exactly one replacement`).toHaveLength(1);
      expect(re[0].t).toBeGreaterThanOrEqual(decl!.t);
      const claim = ev.find((e) => e.type === 'claimed' && taskOf(e) === (re[0].data as { task: string }).task);
      if (claim) expect(claim.agent).not.toBe(victim);
      const r = claim ? claim.t - decl!.t : Infinity;
      rec.push(r);
      rows.push(`seed ${seed}: declared +${(decl!.t - tKill).toFixed(1)} s, recovery ${r.toFixed(1)} s`);
      expect(invariantProblems(ev)).toEqual([]);
    }
    const med = median(rec);
    report.push({ at: 'AT-06', result: `recovery median ${med.toFixed(1)} s (${rows.join('; ')})` });
    expect(med).toBeLessThanOrEqual(30);
  });

  it('AT-09 clock drift: 1 % on one drone (plus a 60 s link loss on it) -> no I1 / I2 / I3 break', () => {
    const scn = SCENARIOS['at09_clock_drift'];
    const drift = scn.faults.find((x): x is Extract<FaultDef, { type: 'clock_drift' }> => x.type === 'clock_drift')!;
    expect(Math.abs(drift.ppm)).toBeGreaterThanOrEqual(10000);
    const { eng, epochDrops } = run(scn, scn.duration_s, true);
    const ev = eng.events;
    expect(ev.some((e) => e.type === 'fault_clock_drift')).toBe(true);
    const m = computeMetrics(ev, scn.duration_s);
    const zs = ev.filter((e) => e.type === 'zombie_stop' && e.agent === drift.id).length;
    const exp = ev.filter((e) => e.type === 'lease_expired').length;
    report.push({ at: 'AT-09', result: `${drift.id} at +${drift.ppm} ppm: delivered ${m.delivered}, zombie stops by ${drift.id} ${zs}, lease re-opens ${exp}, zombie pickups ${m.zombiePickups}, duplicates ${m.duplicateDeliveries}` });
    expect(invariantProblems(ev)).toEqual([]);
    expect(m.zombiePickups).toBe(0);
    expect(epochDrops).toEqual([]);
    expect(m.delivered).toBeGreaterThan(5);
  });

  it('AT-10 heal & converge: replica_converged within T_converge = 10 s of the heal, never replica_not_converged', () => {
    const scn = SCENARIOS['at10_heal_converge'];
    const part = scn.faults.find((f): f is Extract<FaultDef, { type: 'partition' }> => f.type === 'partition')!;
    const { eng, epochDrops } = run(scn, part.until! + 90, true);
    const ev = eng.events;
    expect(ev.some((e) => e.type === 'partition_end')).toBe(true);
    const conv = ev.find((e) => e.type === 'replica_converged');
    expect(conv, 'replica_converged logged').toBeDefined();
    const elapsed = (conv!.data as { elapsed_s: number }).elapsed_s;
    report.push({ at: 'AT-10', result: `converged ${elapsed.toFixed(2)} s after the heal at ${part.until} s (bound ${P2P_DEFAULTS.convergeS} s); replica_not_converged: ${ev.filter((e) => e.type === 'replica_not_converged').length}` });
    expect(conv!.t).toBeGreaterThanOrEqual(part.until! - 1e-6);
    expect(elapsed).toBeLessThanOrEqual(P2P_DEFAULTS.convergeS);
    expect(ev.filter((e) => e.type === 'replica_not_converged')).toEqual([]);
    expect(invariantProblems(ev)).toEqual([]);
    expect(epochDrops).toEqual([]);
  });

  /**
   * AT-11 at N = 30 for a 1 h simulation: s10_scale (8 depots x 3 pads = 24 pads, so 6 public pads are added to fly
   * all 30 drones), with its own policy (QUORUM) and with STRICT. Without the depot backhaul the resting mesh of this
   * 12 km map has no majority component and QUORUM never claims (Decision 19); with it both policies carry load.
   */
  it('AT-11 scalability: N = 30, 1 h: msgs/drone/min <= 120 (beacons excluded), per-tick compute p95 <= 50 ms', () => {
    const lines: string[] = [];
    for (const partition of ['QUORUM', 'STRICT'] as const) {
      const scn = scenarioWith(SCENARIOS['s10_scale'], { world: { public_pads: 6 }, policy: { partition } } as never);
      const seconds = 3600;
      const { eng, tickP95Ms } = run(scn, seconds);
      expect(eng.agents.length).toBe(30);
      let n = 0;
      let beacons = 0;
      for (const a of eng.agents) {
        for (const [type, v] of Object.entries(eng.net.stats(a.id).byType)) {
          if (type === 'HEARTBEAT') beacons += v!.sent;
          else n += v!.sent;
        }
      }
      const perMin = n / eng.agents.length / (seconds / 60);
      const m = computeMetrics(eng.events, seconds);
      const bh = backhaulLoad(eng, seconds);
      lines.push(`${partition}: ${perMin.toFixed(1)} msgs/drone/min (+ ${(beacons / eng.agents.length / (seconds / 60)).toFixed(0)} beacons), backhaul ${bh.backhaulPerDepotMin} copies / ${(bh.backhaulBytesPerDepotS / 1024).toFixed(1)} KB/s per depot, tick p95 ${tickP95Ms.toFixed(2)} ms, delivered ${m.delivered}`);
      expect(perMin).toBeLessThanOrEqual(120);
      expect(tickP95Ms).toBeLessThanOrEqual(50);
    }
    report.push({ at: 'AT-11', result: lines.join('; ') });
  });

  afterAll(() => {
    console.log('\nP2P acceptance results');
    for (const r of report) console.log(`  ${r.at}: ${r.result}`);
  });
});
