import { describe, expect, it } from 'vitest';
import { getScenario } from '../scenario/registry';
import { acceptanceChecks, bootstrapMean, runBench, summaryMarkdown, toCsv, type BenchRow } from './bench';
import { computeMetrics, type LogEvent } from './metrics';

/** TC-12: metrics from the event log, bootstrap statistics, acceptance checks and a tiny end-to-end bench. */

const ev = (t: number, type: string, data: Record<string, unknown> = {}, agent: string | null = null): LogEvent => ({ t, agent, type, data });

describe('computeMetrics', () => {
  const log: LogEvent[] = [
    ev(0, 'task_created', { task: 'T1', deadline: 100 }),
    ev(0, 'task_created', { task: 'T2', deadline: 100 }),
    ev(0, 'task_created', { task: 'T3', deadline: 500 }),
    ev(0, 'task_created', { task: 'T4', deadline: 2000 }),
    ev(10, 'claimed', { task: 'T1' }, 'A01'),
    ev(20, 'zombie_stop', { task: 'T2' }, 'A02'),
    ev(25, 'picked_up', { task: 'T2' }, 'A02'),
    ev(50, 'delivered', { task: 'T1' }, 'A01'),
    ev(60, 'delivered', { task: 'T1' }, 'A03'),
    ev(70, 'fault_kill_service', { name: 'central_hub' }),
    ev(150, 'delivered', { task: 'T2' }, 'A02'),
    ev(160, 'delivered', { task: 'T4' }, 'A04'),
    ev(170, 'lease_expired', { task: 'T3' }),
    ev(180, 'task_taken', { task: 'T3' }, 'A05'),
    ev(190, 'loss_of_separation', { with: 'A02' }, 'A01'),
    ev(9999, 'delivered', { task: 'T3' }, 'A05'),
  ];
  const m = computeMetrics(log, 1000);

  it('counts deliveries, on-time and lateness inside the window', () => {
    expect(m.released).toBe(4);
    expect(m.delivered).toBe(3); // T3 is outside the window
    expect(m.onTime).toBe(2);
    expect(m.onTimePctOfDelivered).toBe(66.7);
    expect(m.meanLatenessS).toBeCloseTo(50 / 3, 1);
  });

  it('on-time rate covers only the tasks that fell due in the window', () => {
    expect(m.due).toBe(3); // T1, T2, T3 (T4 is due after the window)
    expect(m.onTimeRate).toBe(33.3); // only T1
  });

  it('detects invariant breaks and counts fault-era work', () => {
    expect(m.duplicateDeliveries).toBe(1);
    expect(m.zombiePickups).toBe(1);
    expect(m.leaseExpiries).toBe(1);
    expect(m.depotRefusals).toBe(1);
    expect(m.lossOfSeparation).toBe(1);
    expect(m.deliveredAfterFirstFault).toBe(2);
  });

  it('a re-claim clears the zombie mark', () => {
    const m2 = computeMetrics([ev(0, 'zombie_stop', { task: 'T' }, 'A'), ev(1, 'claimed', { task: 'T' }, 'A'), ev(2, 'picked_up', { task: 'T' }, 'A')], 10);
    expect(m2.zombiePickups).toBe(0);
    expect(m2.onTimeRate).toBeNull();
  });
});

describe('bootstrapMean', () => {
  it('brackets the mean and is reproducible', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = bootstrapMean(xs)!;
    expect(a.mean).toBe(5.5);
    expect(a.lo).toBeLessThan(5.5);
    expect(a.hi).toBeGreaterThan(5.5);
    expect(bootstrapMean(xs)).toEqual(a);
    expect(bootstrapMean([])).toBeNull();
    expect(bootstrapMean([3])).toEqual({ mean: 3, lo: 3, hi: 3, n: 1 });
  });
});

describe('acceptanceChecks', () => {
  const row = (scenario: string, system: BenchRow['system'], onTimeRate: number): BenchRow =>
    ({ scenario, system, onTimeRate, duplicateDeliveries: 0, zombiePickups: 0 }) as BenchRow;

  it('AT-05 passes when PACT holds and the central baseline collapses', () => {
    const rows = [row('s0_healthy', 'pact', 90), row('s1_hub_loss', 'pact', 85), row('s0_healthy', 'central_hub_loss', 90), row('s1_hub_loss', 'central_hub_loss', 40)];
    expect(acceptanceChecks(rows)[0].pass).toBe(true);
  });

  it('AT-05 fails when PACT degrades more than 15 %', () => {
    const rows = [row('s0_healthy', 'pact', 90), row('s1_hub_loss', 'pact', 70), row('s0_healthy', 'central_hub_loss', 90), row('s1_hub_loss', 'central_hub_loss', 40)];
    expect(acceptanceChecks(rows)[0].pass).toBe(false);
  });

  it('AT-05 is not evaluated without the hub-loss cells; duplicates fail the invariant check', () => {
    const rows = [{ ...row('s0_healthy', 'pact', 90), duplicateDeliveries: 1 }];
    const [at05, at12] = acceptanceChecks(rows);
    expect(at05.pass).toBeNull();
    expect(at12.pass).toBe(false);
  });
});

describe('runBench (end to end, tiny matrix)', () => {
  it('runs scenario x system x seed, pairs seeds and writes deterministic outputs', { timeout: 120000 }, () => {
    const opts = { scenarios: [getScenario('test_small')], systems: ['pact', 'central_hub_loss'] as const, seeds: 2, windowS: 60 };
    const rows = runBench(opts);
    expect(rows.length).toBe(4);
    const s0 = getScenario('test_small').seed;
    expect(rows.map((r) => `${r.system}@${r.seed}`)).toEqual([`pact@${s0}`, `central_hub_loss@${s0}`, `pact@${s0 + 1}`, `central_hub_loss@${s0 + 1}`]);
    for (const r of rows) {
      expect(r.duplicateDeliveries).toBe(0);
      expect(r.events).toBeGreaterThan(0);
    }
    expect(runBench(opts).map((r) => r.eventHash)).toEqual(rows.map((r) => r.eventHash));
    const csv = toCsv(rows);
    expect(csv.trim().split('\n').length).toBe(5);
    const md = summaryMarkdown(rows, { seeds: 2, windowS: 60 });
    expect(md).toContain('## test_small');
    expect(md).toContain('`central_hub_loss`');
  });
});
