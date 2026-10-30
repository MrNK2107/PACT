import { describe, expect, it } from 'vitest';
import { getScenario, SCENARIOS } from '../scenario/registry';
import { acceptanceChecks, type BenchRow } from './bench';
import { benchOnTimeSvg, messageLoadSvg, recoveryCdfSvg, sweepParetoSvg } from './plots';
import { at12Check, DEFAULT_SWEEP_SCENARIOS, POLICIES, runSweep, sweepCells, sweepCsv, sweepMarkdown, sweepScenario, sweepSize, UNFENCED, type SweepRow } from './sweep';

const row = (o: Partial<SweepRow>): SweepRow =>
  ({ scenario: 'x', system: 'pact', policy: 'QUORUM', onTimeRate: 80, delivered: 10, duplicateDeliveries: 0, zombiePickups: 0, depotRefusals: 0, batteryDepleted: 0, ...o }) as SweepRow;

describe('AT-12 sweep: Pareto cells and the acceptance check', () => {
  it('marks dominated cells and keeps the trade-off front', () => {
    const rows = [
      row({ system: 'pact', policy: 'a', onTimeRate: 80 }),
      row({ system: 'pact', policy: 'b', onTimeRate: 70 }), // dominated by a (same violations, lower rate)
      row({ system: 'cbba_plain', policy: 'a', onTimeRate: 90, duplicateDeliveries: 2 }), // trade-off: faster but unsafe
    ];
    const cells = sweepCells(rows);
    const by = (s: string, p: string) => cells.find((c) => c.system === s && c.policy === p)!;
    expect(by('pact', 'a').pareto).toBe(true);
    expect(by('pact', 'b').pareto).toBe(false);
    expect(by('cbba_plain', 'a').pareto).toBe(true);
    expect(by('cbba_plain', 'a').violations!.mean).toBe(2);
    expect(by('cbba_plain', 'a').duplicates!.mean).toBe(2);
  });

  it('fails on missing runs or fenced violations, but not on cbba_plain duplicates', () => {
    expect(at12Check([row({}), row({ system: 'cbba_plain', duplicateDeliveries: 3 })], 2).pass).toBe(true);
    expect(at12Check([row({})], 2).pass).toBe(false);
    expect(at12Check([row({ zombiePickups: 1 })], 1).pass).toBe(false);
  });

  it('the bench invariant check ignores the unfenced baseline and still gates the fenced ones', () => {
    const b = (system: BenchRow['system'], dup: number) => ({ scenario: 's', system, onTimeRate: 1, duplicateDeliveries: dup, zombiePickups: 0 }) as BenchRow;
    expect(acceptanceChecks([b('pact', 0), b('cbba_plain', 5)])[1].pass).toBe(true);
    expect(acceptanceChecks([b('greedy_nearest', 1), b('cbba_plain', 0)])[1].pass).toBe(false);
  });

  it('AT-05 fails (not "not evaluated") when a healthy cell has an on-time rate of 0', () => {
    const b = (scenario: string, system: BenchRow['system'], onTimeRate: number) => ({ scenario, system, onTimeRate, duplicateDeliveries: 0, zombiePickups: 0 }) as BenchRow;
    const at05 = acceptanceChecks([b('s0_healthy', 'pact', 0), b('s1_hub_loss', 'pact', 0), b('s0_healthy', 'central_hub_loss', 90), b('s1_hub_loss', 'central_hub_loss', 40)])[0];
    expect(at05.pass).toBe(false);
  });

  it('sweeps the three partition policies (Decision 19)', () => {
    expect(POLICIES.map((p) => p.policy.partition)).toEqual(['STRICT', 'QUORUM', 'OPTIMISTIC_BOUNDED']);
    expect(POLICIES.map((p) => p.id)).toEqual(['STRICT', 'QUORUM', 'OPTIMISTIC_BOUNDED']);
  });

  it('resolves the default sweep scenarios; the canyon variant adds one partition and keeps the rest', () => {
    const scns = DEFAULT_SWEEP_SCENARIOS.map((n) => sweepScenario(n, SCENARIOS));
    expect(scns.map((s) => s.name)).toEqual(DEFAULT_SWEEP_SCENARIOS);
    const v = sweepScenario('dm_canyon_partition', SCENARIOS);
    const base = SCENARIOS['dm_canyon_shadow'];
    expect(v.map).toBe(base.map);
    expect(v.network).toEqual(base.network);
    expect(v.faults.filter((f) => f.type === 'partition')).toHaveLength(1);
    expect(v.faults.length).toBe(base.faults.length + 1);
    for (const s of scns) expect(s.faults.some((f) => f.type === 'partition')).toBe(true);
    expect(() => sweepScenario('nope', SCENARIOS)).toThrow();
  });
});

describe('runSweep (tiny matrix) and plots', () => {
  it('runs scenario x policy x seed x system (+ unfenced reference) deterministically and renders outputs', { timeout: 120000 }, () => {
    const opts = { scenarios: [getScenario('test_small')], systems: ['pact'] as const, references: ['cbba_plain'] as const, policies: POLICIES.slice(0, 2), seeds: 1, windowS: 30 };
    const rows = runSweep(opts);
    expect(sweepSize(opts)).toBe(3);
    expect(rows.map((r) => `${r.policy}/${r.system}`)).toEqual(['STRICT/pact', 'QUORUM/pact', `${UNFENCED}/cbba_plain`]);
    expect(runSweep(opts).map((r) => r.eventHash)).toEqual(rows.map((r) => r.eventHash));
    expect(sweepCsv(rows).trim().split('\n').length).toBe(4);
    const md = sweepMarkdown(rows, { seeds: 1, windowS: 30, expected: 3, policies: opts.policies });
    expect(md).toContain('**AT-12**: PASS');
    const svg = sweepParetoSvg(sweepCells(rows), { seeds: 1, windowS: 30 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('cbba_plain');
    const bar = benchOnTimeSvg(rows, { seeds: 1, windowS: 30 });
    expect(bar).toContain('test_small');
    expect(bar.match(/<svg/g)!.length).toBe(1);
    const load = messageLoadSvg(rows, { seeds: 1, windowS: 30 });
    expect(load).toContain('AT-11 budget');
    expect(load.match(/<svg/g)!.length).toBe(1);
    const cdf = recoveryCdfSvg([{ system: 'pact', seed: 1, victim: 'A01', task: 'T', tKill: 10, detectS: 4, recoveryS: 7, totalS: 11 }], { seeds: 1, scenario: 'x' });
    expect(cdf.startsWith('<svg')).toBe(true);
    expect(cdf).toContain('pact: 1/1 recovered');
  });
});
