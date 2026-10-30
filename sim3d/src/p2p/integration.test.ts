import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import type { FaultDef } from '../scenario/types';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';
import { P2P_DEFAULTS } from './contracts';

/**
 * Engine-level P2P integration (TC-07 / TC-08 / TC-09 wiring, docs/P2P_DESIGN.md): under `pact` every drone and depot
 * runs its own replica over the simulated network. Partition, heal and clock-drift runs check the invariants from the
 * event log (I1, I3), sample the replicas every tick (I2) and measure convergence after the heal (AT-10).
 */

interface Run {
  eng: SimulationEngine;
  /** I2 violations: a replica whose epoch for a task went down between two ticks. */
  epochDrops: string[];
}

function run(faults: FaultDef[], seconds: number, over: object = {}): Run {
  const scn = scenarioWith(getScenario('test_small'), { system: 'pact', fleet: { n_drones: 6 }, workload: { arrival_rate_per_min: 4 }, faults, ...over } as never);
  const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
  eng.start();
  const seen = new Map<string, number>();
  const epochDrops: string[] = [];
  for (let i = 0; i < 20 * seconds; i++) {
    eng.update(0.05);
    for (const { id, replica } of eng.replicas()) {
      for (const rec of replica.tasks()) {
        const k = `${id}|${rec.task_id}`;
        const prev = seen.get(k);
        if (prev !== undefined && rec.epoch < prev) epochDrops.push(`${k} ${prev} -> ${rec.epoch} at ${eng.time.toFixed(2)}`);
        seen.set(k, rec.epoch);
      }
    }
  }
  return { eng, epochDrops };
}

/** I1 (no task delivered twice) and I3 (no pickup after the drone's own zombie-stop for that task without a new claim). */
function invariantProblems(eng: SimulationEngine): string[] {
  const out: string[] = [];
  const delivered = new Set<string>();
  const lost = new Set<string>();
  for (const e of eng.events) {
    const task = (e.data as { task?: string }).task;
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

const PART_T = 120;
const HEAL_T = PART_T + 120;

describe('pact over the network: partitions and heal (engine)', () => {
  const cases: [string, string[][]][] = [
    // test_small: A01 / A04 live at D1, A02 / A05 at D2, A03 / A06 at D3
    ['two sides with a depot each', [['D1', 'A01', 'A04'], ['D2', 'D3', 'A02', 'A03', 'A05', 'A06']]],
    ['one side without any depot', [['A01', 'A04'], ['D1', 'D2', 'D3', 'A02', 'A03', 'A05', 'A06']]],
  ];
  for (const [label, groups] of cases) {
    it(`${label}: no I1 / I2 / I3 break; replicas converge within T_converge of the heal`, { timeout: 120000 }, () => {
      const { eng, epochDrops } = run([{ t: PART_T, type: 'partition', groups, until: HEAL_T }], HEAL_T + 60);
      expect(eng.events.some((e) => e.type === 'fault_partition')).toBe(true);
      expect(eng.events.some((e) => e.type === 'partition_end')).toBe(true);
      expect(invariantProblems(eng)).toEqual([]);
      expect(epochDrops).toEqual([]);
      const conv = eng.events.find((e) => e.type === 'replica_converged');
      expect(conv, 'replica_converged logged').toBeDefined();
      expect(conv!.t).toBeGreaterThanOrEqual(HEAL_T - 1e-6);
      expect((conv!.data as { elapsed_s: number }).elapsed_s).toBeLessThanOrEqual(P2P_DEFAULTS.convergeS);
      // work went on during the partition on the side that has depots
      const during = eng.events.filter((e) => e.type === 'delivered' && e.t > PART_T && e.t < HEAL_T);
      expect(during.length).toBeGreaterThan(0);
    });
  }

  it('the drones cut off from every depot claim nothing new while cut off', { timeout: 120000 }, () => {
    const { eng } = run([{ t: PART_T, type: 'partition', groups: [['A01', 'A04'], ['D1', 'D2', 'D3', 'A02', 'A03', 'A05', 'A06']], until: HEAL_T }], HEAL_T + 10);
    // after the cut is known (reach window + one status period), a cut-off drone cannot reach any origin depot
    const lateClaims = eng.events.filter((e) => e.type === 'claimed' && (e.agent === 'A01' || e.agent === 'A04') && e.t > PART_T + 5 && e.t < HEAL_T);
    expect(lateClaims).toEqual([]);
  });
});

describe('pact over the network: clock drift (AT-09 shape)', () => {
  for (const ppm of [10000, -10000]) {
    it(`1 % drift (${ppm} ppm) on one drone: no I3 / I1 break`, { timeout: 120000 }, () => {
      const { eng, epochDrops } = run([{ t: 0, type: 'clock_drift', id: 'A01', ppm }], 600);
      expect(eng.events.some((e) => e.type === 'fault_clock_drift')).toBe(true);
      expect(invariantProblems(eng)).toEqual([]);
      expect(epochDrops).toEqual([]);
      expect(eng.events.filter((e) => e.type === 'delivered').length).toBeGreaterThan(5);
    });
  }
  it('1 % drift on the depot that arbitrates and re-opens: no I3 break', { timeout: 120000 }, () => {
    const { eng } = run([{ t: 0, type: 'clock_drift', id: 'D1', ppm: -10000 }], 600);
    expect(invariantProblems(eng)).toEqual([]);
  });
});

describe('pact over the network: drone failure (AT-06 shape)', () => {
  it('a killed carrier: its origin depot aborts the parcel and orders exactly one replacement', { timeout: 120000 }, () => {
    // find a drone that carries a parcel at some point, then kill it while it does
    const probe = run([], 200).eng;
    const pick = probe.events.find((e) => e.type === 'picked_up' && e.t > 30)!;
    expect(pick).toBeDefined();
    const victim = pick.agent!;
    const tKill = pick.t + 10;
    const { eng } = run([{ t: tKill, type: 'kill_drone', id: victim }], tKill + 150);
    const lost = eng.events.find((e) => e.type === 'drone_lost_in_flight' && e.agent === victim);
    expect(lost, 'victim carried a parcel when killed').toBeDefined();
    const task = (lost!.data as { task: string }).task;
    const reorders = eng.events.filter((e) => e.type === 'task_reordered' && (e.data as { of?: string }).of === task);
    expect(reorders).toHaveLength(1);
    expect(eng.board.get(task)!.state).toBe('ABORTED');
    expect(eng.board.get(`${task}:r1`)).toBeDefined();
    expect(invariantProblems(eng)).toEqual([]);
  });

  it('a killed pre-pickup owner: only the origin depot re-opens the task, after the observer bound', { timeout: 120000 }, () => {
    const probe = run([], 200).eng;
    const claim = probe.events.find((e) => e.type === 'claimed' && e.t > 30)!;
    const victim = claim.agent!;
    const task = (claim.data as { task: string }).task;
    const { eng } = run([{ t: claim.t + 1, type: 'kill_drone', id: victim }], claim.t + 60);
    const exp = eng.events.filter((e) => e.type === 'lease_expired' && (e.data as { task?: string }).task === task);
    expect(exp).toHaveLength(1);
    expect((exp[0].data as { node: string }).node).toBe(task.split(':')[0]);
    // never before the observer bound lease (1 + margin) + grace after the kill
    const lease = eng.scenario.policy.lease_ttl_s;
    expect(exp[0].t - (claim.t + 1)).toBeGreaterThan(lease * (1 + P2P_DEFAULTS.lease.driftMargin));
  });
});

describe('AT-06: drone failure, recovery after DECLARED_FAILED (engine, several seeds)', () => {
  /**
   * Kill a drone 10 s after it picked up a parcel (first pickup after t = 120 s, steady state). Per seed: the origin
   * depot declares it failed (peer_failed), orders exactly one replacement and never before the declaration. Recovery =
   * sim time from that declaration (origin depot's `peer_failed` of the carrier) to the first `claimed` of the
   * replacement by another drone. AT-06: median over the seeds <= 30 s. Fleet: test_small with 8 drones (3 pads per
   * depot), 2 orders / min, so the fleet has the spare capacity a recovery needs (DECISIONS.md).
   */
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  function at06Run(seed: number, faults: FaultDef[], seconds: number): SimulationEngine {
    const scn = scenarioWith(getScenario('test_small'), {
      system: 'pact',
      seed,
      fleet: { n_drones: 8 },
      world: { size_m: [2000, 2000], depots: 3, pads_per_depot: 3, no_fly: ['auto'], wind: { mean_mps: 3 } },
      workload: { arrival_rate_per_min: 2 },
      faults,
    } as never);
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * seconds; i++) eng.update(0.05);
    return eng;
  }

  it('replacement only after DECLARED_FAILED; recovery median <= 30 s after the declaration', { timeout: 300000 }, () => {
    const rec: number[] = [];
    const rows: string[] = [];
    for (const seed of SEEDS) {
      const pick = at06Run(seed, [], 330).events.find((e) => e.type === 'picked_up' && e.t > 120)!;
      expect(pick, `seed ${seed}: a pickup after 120 s`).toBeDefined();
      const victim = pick.agent!;
      const task = (pick.data as { task: string }).task;
      const depot = task.split(':')[0];
      const tKill = pick.t + 10;
      const eng = at06Run(seed, [{ t: tKill, type: 'kill_drone', id: victim }], tKill + 200);
      expect(eng.events.some((e) => e.type === 'drone_lost_in_flight' && e.agent === victim), `seed ${seed}: carrier killed in flight`).toBe(true);
      const decl = eng.events.find((e) => e.type === 'peer_failed' && (e.data as { node: string; peer: string }).node === depot && (e.data as { peer: string }).peer === victim);
      expect(decl, `seed ${seed}: origin depot declares ${victim} failed`).toBeDefined();
      expect((decl!.data as { carrying: string[] }).carrying).toContain(task);
      const re = eng.events.filter((e) => e.type === 'task_reordered' && (e.data as { of?: string }).of === task);
      expect(re, `seed ${seed}: exactly one replacement`).toHaveLength(1);
      expect(re[0].t).toBeGreaterThanOrEqual(decl!.t);
      expect(re[0].data).toMatchObject({ cause: 'declared_failed', peer: victim, node: depot });
      const replacement = (re[0].data as { task: string }).task;
      const claim = eng.events.find((e) => e.type === 'claimed' && (e.data as { task?: string }).task === replacement);
      if (claim) expect(claim.agent).not.toBe(victim);
      const r = claim ? claim.t - decl!.t : Infinity;
      rec.push(r);
      rows.push(`seed ${seed}: ${victim} killed ${tKill.toFixed(1)} s, declared +${(decl!.t - tKill).toFixed(1)} s (${(decl!.data as { reason: string }).reason}), replacement claimed +${r.toFixed(1)} s`);
      expect(invariantProblems(eng)).toEqual([]);
    }
    const sorted = [...rec].sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    console.log(`[AT-06] recovery after declaration (s), median ${median.toFixed(1)}\n  ${rows.join('\n  ')}`);
    expect(median).toBeLessThanOrEqual(30);
  });
});

describe('pact over the network: ledger and message budget', () => {
  it('the ledger is the merge of every replica: no replica holds a record newer than the ledger', { timeout: 120000 }, () => {
    const { eng } = run([], 300);
    for (const { replica } of eng.replicas()) {
      for (const r of replica.tasks()) {
        const l = eng.board.get(r.task_id)!;
        expect(l, r.task_id).toBeDefined();
        expect(r.epoch).toBeLessThanOrEqual(l.epoch);
      }
    }
  });

  it('AT-11: fewer than 120 messages per drone per minute besides beacons in a healthy run', { timeout: 120000 }, () => {
    const seconds = 300;
    const { eng } = run([], seconds);
    let n = 0;
    for (const a of eng.agents) {
      const st = eng.net.stats(a.id);
      for (const [type, v] of Object.entries(st.byType)) if (type !== 'HEARTBEAT') n += v!.sent;
    }
    expect(n / eng.agents.length / (seconds / 60)).toBeLessThan(120);
  });
});

describe('QUORUM over the fleet roster with the depot backhaul (Decisions 19, 20)', () => {
  it('a boot-time minority {D1, A01, A04} cut from the other depots too (backhaul included) never claims; the majority does', { timeout: 120000 }, () => {
    const groups = [['D1', 'A01', 'A04'], ['D2', 'D3', 'A02', 'A03', 'A05', 'A06']];
    const { eng } = run([{ t: 0, type: 'partition', groups, until: 300 }], 300);
    const claims = eng.events.filter((e) => e.type === 'claimed' && e.t < 300);
    expect(claims.filter((e) => e.agent === 'A01' || e.agent === 'A04')).toEqual([]);
    expect(claims.length).toBeGreaterThan(0);
    expect(eng.net.backhaulUp('D1', 'D2')).toBe(false);
    expect(eng.net.backhaulUp('D2', 'D3')).toBe(true);
    expect(invariantProblems(eng)).toEqual([]);
  });

  it('coastal_metro s0_healthy (depots beyond radio range of each other): drone statuses relay through the depots, QUORUM holds, drones claim and deliver', { timeout: 120000 }, () => {
    const scn = getScenario('s0_healthy');
    expect(scn.policy.partition).toBe('QUORUM');
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    let maxReach = 0;
    for (let i = 0; i < 20 * 300; i++) {
      eng.update(0.05);
      if (i % 20 === 0 && eng.time > 10) for (const a of eng.agents) maxReach = Math.max(maxReach, eng.nodeOf(a.id)!.view.reachable().length);
    }
    // parked drones hear only their own depot's pair by radio; a majority of 6 is reachable only via the backhaul relay
    expect(maxReach).toBeGreaterThan(eng.agents.length / 2);
    expect(eng.events.filter((e) => e.type === 'claimed').length).toBeGreaterThan(0);
    expect(eng.events.filter((e) => e.type === 'delivered').length).toBeGreaterThanOrEqual(2);
    expect(invariantProblems(eng)).toEqual([]);
  });

  it('coastal_metro without the backhaul stalls under QUORUM (the reason for it)', { timeout: 120000 }, () => {
    const scn = scenarioWith(getScenario('s0_healthy'), { network: { backhaul: { enabled: false } } } as never);
    const eng = new SimulationEngine(createWorld(worldConfigFrom(scn)), scn);
    eng.start();
    for (let i = 0; i < 20 * 300; i++) eng.update(0.05);
    expect(eng.events.filter((e) => e.type === 'claimed')).toEqual([]);
  });
});
