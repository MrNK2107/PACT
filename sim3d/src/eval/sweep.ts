import type { PartitionPolicyName } from '../p2p/contracts';
import { scenarioWith } from '../scenario/load';
import type { Scenario } from '../scenario/types';
import { isFenced, type SystemId } from '../sim/systems';
import { bootstrapMean, runOne, type BenchRow, type Estimate } from './bench';

/**
 * AT-12 policy sweep (docs/04 PRD AT-12: "run 3 policies x 30 seeds; report Pareto data without crashes").
 *
 * The policy axis is the three partition policies of 03 section 3.5f (STRICT / QUORUM / OPTIMISTIC_BOUNDED), which
 * act through the P2P layer under `pact` (Decisions 16-19; before the network model existed the axis was
 * `soc_reserve`, Decision 14). The sweep runs on partition scenarios; `cbba_plain` (no fencing, no partition policy)
 * runs once per scenario as the unfenced reference. Each (scenario, system, policy) cell is one point of the Pareto
 * data: on-time rate (higher is better) against ownership violations, i.e. duplicate deliveries + zombie pickups per
 * run (lower is better). Wasted sorties (depot refusals, `task_taken`) are reported next to them.
 */

export interface PolicyPreset {
  id: string;
  label: string;
  policy: Partial<Scenario['policy']>;
}

const partition = (p: PartitionPolicyName, label: string): PolicyPreset => ({ id: p, label, policy: { partition: p } });

export const POLICIES: readonly PolicyPreset[] = [
  partition('STRICT', 'claim only under a live shard lease held on my side (REQ-OWN-005)'),
  partition('QUORUM', 'claim only while a strict majority of the fleet roster is reachable'),
  partition('OPTIMISTIC_BOUNDED', 'QUORUM, or at most 1 priority >= 2 claim without it; never priority 1'),
];

/** Policy id of the unfenced reference rows (`cbba_plain` ignores the partition policy). */
export const UNFENCED = 'unfenced';

/**
 * Sweep scenarios that are variants of shipped ones (a scripted partition added; nothing else changes). Partition
 * on dm_canyon_shadow: the south depots D1 / D4 and their four drones against the north depots D2 / D3 and theirs,
 * for 5 min before the scenario's own radio blackout (600-900 s).
 */
export const SWEEP_VARIANTS: Record<string, { base: string; over: (s: Scenario) => Partial<Scenario> }> = {
  dm_canyon_partition: {
    base: 'dm_canyon_shadow',
    over: (s) => ({
      description: `${s.description} Sweep variant: partition {D1, D4, A01, A04, A05, A08} | {D2, D3, A02, A03, A06, A07} from 300 s to 600 s.`,
      faults: [{ t: 300, type: 'partition', groups: [['D1', 'D4', 'A01', 'A04', 'A05', 'A08'], ['D2', 'D3', 'A02', 'A03', 'A06', 'A07']], until: 600 }, ...s.faults],
    }),
  },
};

export const DEFAULT_SWEEP_SCENARIOS = ['at03_split_brain_strict', 'dm_canyon_partition'];

/** A shipped scenario, or a sweep variant of one (named after the variant). */
export function sweepScenario(name: string, registry: Record<string, Scenario>): Scenario {
  if (registry[name]) return registry[name];
  const v = SWEEP_VARIANTS[name];
  if (!v || !registry[v.base]) throw new Error(`unknown sweep scenario ${name}; known: ${[...Object.keys(registry), ...Object.keys(SWEEP_VARIANTS)].join(', ')}`);
  const base = registry[v.base];
  return { ...scenarioWith(base, v.over(base) as never), name };
}

export interface SweepRow extends BenchRow {
  policy: string;
}

export interface SweepOptions {
  scenarios: Scenario[];
  /** Fenced systems, run once per policy. */
  systems: readonly SystemId[];
  /** Unfenced references (`cbba_plain`), run once per scenario with policy id `unfenced`. */
  references?: readonly SystemId[];
  policies: readonly PolicyPreset[];
  seeds: number;
  windowS: number;
  onRun?: (row: SweepRow, i: number, total: number) => void;
  /** A run that threw: recorded, and the sweep carries on (AT-12 then fails). */
  onError?: (crash: SweepCrash) => void;
}

export interface SweepCrash {
  scenario: string;
  system: SystemId;
  policy: string;
  seed: number;
  error: string;
}

/** Planned run count of a sweep. */
export function sweepSize(o: Pick<SweepOptions, 'scenarios' | 'systems' | 'references' | 'policies' | 'seeds'>): number {
  return o.scenarios.length * o.seeds * (o.systems.length * o.policies.length + (o.references?.length ?? 0));
}

/** scenario x seed x (policy x system + references); run i uses `scenario.seed + i`, so every cell is paired. */
export function runSweep(o: SweepOptions): SweepRow[] {
  const rows: SweepRow[] = [];
  const total = sweepSize(o);
  const one = (s: Scenario, sys: SystemId, policy: string, seed: number) => {
    let row: SweepRow;
    try {
      row = { ...runOne(s, sys, seed, o.windowS), policy };
    } catch (e) {
      o.onError?.({ scenario: s.name, system: sys, policy, seed, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    rows.push(row);
    o.onRun?.(row, rows.length, total);
  };
  for (const scn of o.scenarios) {
    for (const p of o.policies) {
      const s: Scenario = { ...scn, policy: { ...scn.policy, ...p.policy } };
      for (let i = 0; i < o.seeds; i++) for (const sys of o.systems) one(s, sys, p.id, scn.seed + i);
    }
    for (let i = 0; i < o.seeds; i++) for (const sys of o.references ?? []) one(scn, sys, UNFENCED, scn.seed + i);
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
  duplicates: Estimate | null;
  zombies: Estimate | null;
  /** Wasted sorties: pickups the depot refused (`task_taken`) per run. */
  refusals: Estimate | null;
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
      duplicates: bootstrapMean(rs.map((r) => r.duplicateDeliveries)),
      zombies: bootstrapMean(rs.map((r) => r.zombiePickups)),
      refusals: bootstrapMean(rs.map((r) => r.depotRefusals)),
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

const SWEEP_COLS: (keyof SweepRow)[] = ['scenario', 'map', 'system', 'policy', 'seed', 'windowS', 'released', 'due', 'delivered', 'onTime', 'onTimeRate', 'meanLatenessS', 'duplicateDeliveries', 'zombiePickups', 'leaseExpiries', 'depotRefusals', 'lossOfSeparation', 'batteryDepleted', 'msgsPerDroneMin', 'events', 'eventHash', 'tickP95Ms'];

export function sweepCsv(rows: readonly SweepRow[]): string {
  const lines = [SWEEP_COLS.join(',')];
  for (const r of rows) lines.push(SWEEP_COLS.map((c) => (r[c] === null || r[c] === undefined ? '' : String(r[c]))).join(','));
  return lines.join('\n') + '\n';
}

function f(e: Estimate | null, d = 1): string {
  if (!e) return 'n/a';
  if (e.n === 1 || e.lo === e.hi) return e.mean.toFixed(d);
  return `${e.mean.toFixed(d)} [${e.lo.toFixed(d)}, ${e.hi.toFixed(d)}]`;
}

export function sweepMarkdown(rows: readonly SweepRow[], o: { seeds: number; windowS: number; expected: number; policies: readonly PolicyPreset[]; descriptions?: Record<string, string> }): string {
  const cells = sweepCells(rows);
  const at12 = at12Check(rows, o.expected);
  const L: string[] = [];
  L.push('# PACT AT-12 policy sweep', '');
  L.push(`${rows.length} runs: scenario x (policy x \`pact\` + \`cbba_plain\` reference) x ${o.seeds} seed(s), ${o.windowS} s of simulated time each. Values are means with a 95 % bootstrap CI. Simulation only.`, '');
  L.push('The policy axis is the partition policy (`policy.partition`) under `pact`. `cbba_plain` has no fencing and no partition policy; it runs once per scenario as the unfenced reference (policy `unfenced`).', '');
  L.push('**Violations** = duplicate deliveries + zombie pickups per run. **Refusals** = pickups the depot refused (`task_taken`, a wasted sortie) per run. **Pareto** = not dominated within the scenario on (on-time rate up, violations down).', '');
  for (const p of o.policies) L.push(`- \`${p.id}\`: ${p.label}`);
  L.push('');
  for (const scn of [...new Set(cells.map((c) => c.scenario))]) {
    L.push(`## ${scn}`, '');
    if (o.descriptions?.[scn]) L.push(o.descriptions[scn], '');
    L.push('| System | Policy | Runs | On-time rate % | Delivered | Duplicates / run | Zombie pickups / run | Refusals / run | Battery depleted | Pareto |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const c of cells.filter((x) => x.scenario === scn)) {
      L.push(`| \`${c.system}\` | \`${c.policy}\` | ${c.runs} | ${f(c.onTimeRate)} | ${f(c.delivered)} | ${f(c.duplicates, 2)} | ${f(c.zombies, 2)} | ${f(c.refusals, 2)} | ${c.batteryDepleted} | ${c.pareto ? 'yes' : ''} |`);
    }
    L.push('');
  }
  L.push('## Acceptance check', '');
  L.push(`- **AT-12**: ${at12.pass ? 'PASS' : 'FAIL'} — ${at12.detail}`, '');
  return L.join('\n');
}
