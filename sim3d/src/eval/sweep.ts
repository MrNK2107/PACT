import type { Scenario } from '../scenario/types';
import { isFenced, type SystemId } from '../sim/systems';
import { bootstrapMean, runOne, type BenchRow, type Estimate } from './bench';

/**
 * AT-12 policy sweep (docs/04 PRD AT-12: "run 3 policies x 30 seeds; report Pareto data without crashes").
 *
 * The PRD's partition policies (STRICT / QUORUM / OPTIMISTIC_BOUNDED) need the partition network model, which does
 * not exist yet (TC-02 / TC-07), so `policy.partition` has no effect in this simulator. The sweep therefore varies
 * the policy knob that does change behaviour today, the energy reserve a drone must keep after a task
 * (`policy.soc_reserve`, a hard constraint in the bid), and crosses it with the ownership protocol (fenced `pact`
 * vs unfenced `cbba_plain`). Each (scenario, system, policy) cell is one point of the Pareto data: on-time rate
 * (higher is better) against ownership violations, i.e. duplicate deliveries + zombie pickups (lower is better).
 */

export interface PolicyPreset {
  id: string;
  label: string;
  policy: Partial<Scenario['policy']>;
}

export const POLICIES: readonly PolicyPreset[] = [
  { id: 'reserve_10', label: 'energy reserve 10 %', policy: { soc_reserve: 0.1 } },
  { id: 'reserve_20', label: 'energy reserve 20 % (default)', policy: { soc_reserve: 0.2 } },
  { id: 'reserve_30', label: 'energy reserve 30 %', policy: { soc_reserve: 0.3 } },
];

export interface SweepRow extends BenchRow {
  policy: string;
}

export interface SweepOptions {
  scenarios: Scenario[];
  systems: readonly SystemId[];
  policies: readonly PolicyPreset[];
  seeds: number;
  windowS: number;
  onRun?: (row: SweepRow, i: number, total: number) => void;
  /** A run that threw (e.g. world generation failed for that seed): recorded, and the sweep carries on. */
  onError?: (crash: SweepCrash) => void;
}

export interface SweepCrash {
  scenario: string;
  system: SystemId;
  policy: string;
  seed: number;
  error: string;
}

/** scenario x policy x seed x system; run i uses `scenario.seed + i`, so every cell is paired on identical seeds. */
export function runSweep(o: SweepOptions): SweepRow[] {
  const rows: SweepRow[] = [];
  const total = o.scenarios.length * o.policies.length * o.seeds * o.systems.length;
  for (const scn of o.scenarios) {
    for (const p of o.policies) {
      const s: Scenario = { ...scn, policy: { ...scn.policy, ...p.policy } };
      for (let i = 0; i < o.seeds; i++) {
        for (const sys of o.systems) {
          let row: SweepRow;
          try {
            row = { ...runOne(s, sys, scn.seed + i, o.windowS), policy: p.id };
          } catch (e) {
            o.onError?.({ scenario: scn.name, system: sys, policy: p.id, seed: scn.seed + i, error: e instanceof Error ? e.message : String(e) });
            continue;
          }
          rows.push(row);
          o.onRun?.(row, rows.length, total);
        }
      }
    }
  }
  return rows;
}

export interface SweepCell {
  scenario: string;
  system: SystemId;
  policy: string;
  runs: number;
  onTimeRate: Estimate | null;
  delivered: Estimate | null;
  /** Duplicate deliveries + zombie pickups per run. */
  violations: Estimate | null;
  batteryDepleted: number;
  /** Not dominated within its scenario (higher on-time rate, fewer violations). */
  pareto: boolean;
}

const num = (xs: (number | null)[]) => xs.filter((v): v is number => typeof v === 'number');

export function sweepCells(rows: readonly SweepRow[]): SweepCell[] {
  const keys = [...new Set(rows.map((r) => `${r.scenario}|${r.system}|${r.policy}`))];
  const cells: SweepCell[] = keys.map((k) => {
    const [scenario, system, policy] = k.split('|');
    const rs = rows.filter((r) => r.scenario === scenario && r.system === system && r.policy === policy);
    return {
      scenario,
      system: system as SystemId,
      policy,
      runs: rs.length,
      onTimeRate: bootstrapMean(num(rs.map((r) => r.onTimeRate))),
      delivered: bootstrapMean(rs.map((r) => r.delivered)),
      violations: bootstrapMean(rs.map((r) => r.duplicateDeliveries + r.zombiePickups)),
      batteryDepleted: rs.reduce((a, r) => a + r.batteryDepleted, 0),
      pareto: false,
    };
  });
  for (const c of cells) c.pareto = !cells.some((d) => d !== c && d.scenario === c.scenario && dominates(d, c));
  return cells;
}

export function dominates(a: SweepCell, b: SweepCell): boolean {
  const ao = a.onTimeRate?.mean ?? -Infinity;
  const bo = b.onTimeRate?.mean ?? -Infinity;
  const av = a.violations?.mean ?? Infinity;
  const bv = b.violations?.mean ?? Infinity;
  return ao >= bo && av <= bv && (ao > bo || av < bv);
}

/** AT-12: every planned run finished; fenced systems kept I1 / I3; Pareto data reported. */
export function at12Check(rows: readonly SweepRow[], expected: number): { pass: boolean; detail: string } {
  const fenced = rows.filter((r) => isFenced(r.system));
  const v = fenced.reduce((a, r) => a + r.duplicateDeliveries + r.zombiePickups, 0);
  const pass = rows.length === expected && v === 0;
  return { pass, detail: `${rows.length}/${expected} runs completed without crashing; fenced-system I1 / I3 violations ${v}` };
}

const SWEEP_COLS: (keyof SweepRow)[] = ['scenario', 'map', 'system', 'policy', 'seed', 'windowS', 'released', 'due', 'delivered', 'onTime', 'onTimeRate', 'meanLatenessS', 'duplicateDeliveries', 'zombiePickups', 'leaseExpiries', 'depotRefusals', 'lossOfSeparation', 'batteryDepleted', 'events', 'eventHash', 'tickP95Ms'];

export function sweepCsv(rows: readonly SweepRow[]): string {
  const lines = [SWEEP_COLS.join(',')];
  for (const r of rows) lines.push(SWEEP_COLS.map((c) => (r[c] === null ? '' : String(r[c]))).join(','));
  return lines.join('\n') + '\n';
}

function f(e: Estimate | null, d = 1): string {
  if (!e) return 'n/a';
  if (e.n === 1 || e.lo === e.hi) return e.mean.toFixed(d);
  return `${e.mean.toFixed(d)} [${e.lo.toFixed(d)}, ${e.hi.toFixed(d)}]`;
}

export function sweepMarkdown(rows: readonly SweepRow[], o: { seeds: number; windowS: number; expected: number; policies: readonly PolicyPreset[] }): string {
  const cells = sweepCells(rows);
  const at12 = at12Check(rows, o.expected);
  const L: string[] = [];
  L.push('# PACT AT-12 policy sweep', '');
  L.push(`${rows.length} runs: scenario x system x policy x ${o.seeds} seed(s), ${o.windowS} s of simulated time each. Values are means with a 95 % bootstrap CI. Simulation only.`, '');
  L.push('Policies vary `policy.soc_reserve`. The partition policies STRICT / QUORUM / OPTIMISTIC_BOUNDED need the network model, which is not implemented, so they are not swept. Systems: `pact` (fenced: atomic claims, leases, depot arbitration) and `cbba_plain` (unfenced).', '');
  L.push('**Violations** = duplicate deliveries + zombie pickups per run. **Pareto** = not dominated within the scenario on (on-time rate up, violations down).', '');
  for (const p of o.policies) L.push(`- \`${p.id}\`: ${p.label}`);
  L.push('');
  for (const scn of [...new Set(cells.map((c) => c.scenario))]) {
    L.push(`## ${scn}`, '');
    L.push('| System | Policy | Runs | On-time rate % | Delivered | Violations / run | Battery depleted | Pareto |');
    L.push('|---|---|---|---|---|---|---|---|');
    for (const c of cells.filter((x) => x.scenario === scn)) {
      L.push(`| \`${c.system}\` | \`${c.policy}\` | ${c.runs} | ${f(c.onTimeRate)} | ${f(c.delivered)} | ${f(c.violations, 2)} | ${c.batteryDepleted} | ${c.pareto ? 'yes' : ''} |`);
    }
    L.push('');
  }
  L.push('## Acceptance check', '');
  L.push(`- **AT-12**: ${at12.pass ? 'PASS' : 'FAIL'} — ${at12.detail}`, '');
  return L.join('\n');
}
