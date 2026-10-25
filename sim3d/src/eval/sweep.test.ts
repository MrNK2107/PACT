import { describe, expect, it } from 'vitest';
import { getScenario } from '../scenario/registry';
import { acceptanceChecks, type BenchRow } from './bench';
import { benchOnTimeSvg, sweepParetoSvg } from './plots';
import { at12Check, POLICIES, runSweep, sweepCells, sweepCsv, sweepMarkdown, type SweepRow } from './sweep';

const row = (o: Partial<SweepRow>): SweepRow =>
  ({ scenario: 'x', system: 'pact', policy: 'reserve_20', onTimeRate: 80, delivered: 10, duplicateDeliveries: 0, zombiePickups: 0, batteryDepleted: 0, ...o }) as SweepRow;

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

  it('defines three policies that change soc_reserve', () => {
    expect(POLICIES.map((p) => p.policy.soc_reserve)).toEqual([0.1, 0.2, 0.3]);
  });
});

describe('runSweep (tiny matrix) and plots', () => {
  it('runs scenario x policy x seed x system deterministically and renders outputs', { timeout: 120000 }, () => {
    const opts = { scenarios: [getScenario('test_small')], systems: ['pact', 'cbba_plain'] as const, policies: POLICIES.slice(0, 2), seeds: 1, windowS: 30 };
    const rows = runSweep(opts);
    expect(rows.map((r) => `${r.policy}/${r.system}`)).toEqual(['reserve_10/pact', 'reserve_10/cbba_plain', 'reserve_20/pact', 'reserve_20/cbba_plain']);
    expect(runSweep(opts).map((r) => r.eventHash)).toEqual(rows.map((r) => r.eventHash));
    expect(sweepCsv(rows).trim().split('\n').length).toBe(5);
    const md = sweepMarkdown(rows, { seeds: 1, windowS: 30, expected: 4, policies: opts.policies });
    expect(md).toContain('**AT-12**: PASS');
    const svg = sweepParetoSvg(sweepCells(rows), { seeds: 1, windowS: 30 });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('cbba_plain');
    const bar = benchOnTimeSvg(rows, { seeds: 1, windowS: 30 });
    expect(bar).toContain('test_small');
    expect(bar.match(/<svg/g)!.length).toBe(1);
  });
});
