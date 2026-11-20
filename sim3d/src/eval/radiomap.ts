import type { SystemId } from '../sim/systems';
import { bootstrapMean, type BenchRow, type Estimate, type RecoveryRow } from './bench';

/**
 * Evaluation of radio-shadow-aware ownership (Decision 22): `pact` (planned silence on) against the ablation
 * `pact_fixed_lease` (today's fixed leases) on identical seeds, plus the AT-06 recovery measure for both. Pure
 * functions over bench rows; `scripts/radiomap.ts` runs the matrix and writes results/radiomap/.
 */

export const RADIOMAP_SYSTEMS: readonly SystemId[] = ['pact_fixed_lease', 'pact'];
export const RADIOMAP_SCENARIOS = ['dm_canyon_shadow', 'dm_canyon_partition', 'dm_healthy', 's0_healthy', 's1_hub_loss'];

/** Bench row plus the radio-map experiment's own measures. */
export interface RadiomapRow extends BenchRow {
  /** Lease expiries after the warm-up (the first `WARMUP_S` s, while the fleet is still learning the map). */
  leaseExpiriesAfterWarmup: number;
  /** Radio-map cells known (>= minSamples) to drone A01 at the end of the run (0 without a radio map). */
  mapCells: number;
}

/** Warm-up excluded from `leaseExpiriesAfterWarmup` (s). */
export const WARMUP_S = 300;

type NumKey = 'onTimeRate' | 'delivered' | 'meanLatenessS' | 'leaseExpiries' | 'falseReopens' | 'plannedSilences' | 'depotRefusals' | 'duplicateDeliveries' | 'zombiePickups' | 'lossOfSeparation' | 'msgsPerDroneMin' | 'bytesPerDroneS' | 'leaseExpiriesAfterWarmup';

export const RADIOMAP_METRICS: { key: NumKey; label: string; digits: number; better: 'up' | 'down' | 'zero' | null }[] = [
  { key: 'onTimeRate', label: 'On-time rate %', digits: 1, better: 'up' },
  { key: 'delivered', label: 'Delivered', digits: 1, better: 'up' },
  { key: 'meanLatenessS', label: 'Mean lateness s', digits: 1, better: 'down' },
  { key: 'leaseExpiries', label: 'Lease expiries (re-opens)', digits: 2, better: 'down' },
  { key: 'falseReopens', label: 'False re-opens (owner alive)', digits: 2, better: 'down' },
  { key: 'leaseExpiriesAfterWarmup', label: `Lease expiries after ${WARMUP_S} s (map learned)`, digits: 2, better: 'down' },
  { key: 'plannedSilences', label: 'Planned silences', digits: 1, better: null },
  { key: 'depotRefusals', label: 'Depot refusals', digits: 2, better: 'down' },
  { key: 'duplicateDeliveries', label: 'Duplicate deliveries', digits: 2, better: 'zero' },
  { key: 'zombiePickups', label: 'Zombie pickups', digits: 2, better: 'zero' },
  { key: 'lossOfSeparation', label: 'Loss of separation', digits: 2, better: 'zero' },
  { key: 'msgsPerDroneMin', label: 'Msgs / drone / min', digits: 1, better: 'down' },
  { key: 'bytesPerDroneS', label: 'Radio bytes / drone / s', digits: 0, better: 'down' },
];

function num(r: BenchRow, k: NumKey): number | null {
  const v = (r as Partial<RadiomapRow>)[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export interface PairedCell {
  scenario: string;
  metric: NumKey;
  base: Estimate | null;
  treat: Estimate | null;
  /** Per-seed difference treat - base on the seeds both systems ran (paired bootstrap CI). */
  diff: Estimate | null;
  baseSum: number;
  treatSum: number;
}

/** Per scenario and metric: both systems' means with 95 % bootstrap CIs and the paired difference. */
export function pairedCells(rows: readonly BenchRow[], base: SystemId = 'pact_fixed_lease', treat: SystemId = 'pact'): PairedCell[] {
  const out: PairedCell[] = [];
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  for (const scn of scenarios) {
    const b = rows.filter((r) => r.scenario === scn && r.system === base);
    const t = rows.filter((r) => r.scenario === scn && r.system === treat);
    const bySeed = new Map(b.map((r) => [r.seed, r]));
    for (const m of RADIOMAP_METRICS) {
      const bv = b.map((r) => num(r, m.key)).filter((v): v is number => v !== null);
      const tv = t.map((r) => num(r, m.key)).filter((v): v is number => v !== null);
      const d: number[] = [];
      for (const r of [...t].sort((x, y) => x.seed - y.seed)) {
        const o = bySeed.get(r.seed);
        const x = num(r, m.key);
        const y = o ? num(o, m.key) : null;
        if (x !== null && y !== null) d.push(x - y);
      }
      out.push({ scenario: scn, metric: m.key, base: bootstrapMean(bv), treat: bootstrapMean(tv), diff: bootstrapMean(d, 2000, 7), baseSum: bv.reduce((a, v) => a + v, 0), treatSum: tv.reduce((a, v) => a + v, 0) });
    }
  }
  return out;
}

function fmt(e: Estimate | null, digits: number): string {
  if (!e) return 'n/a';
  if (e.n === 1 || e.lo === e.hi) return e.mean.toFixed(digits);
  return `${e.mean.toFixed(digits)} [${e.lo.toFixed(digits)}, ${e.hi.toFixed(digits)}]`;
}

function signed(e: Estimate | null, digits: number): string {
  if (!e) return 'n/a';
  const s = (v: number) => (v > 0 ? '+' : '') + v.toFixed(digits);
  if (e.n === 1 || e.lo === e.hi) return s(e.mean);
  return `${s(e.mean)} [${s(e.lo)}, ${s(e.hi)}]`;
}

export interface RecoverySummary {
  system: SystemId;
  runs: number;
  detectMedianS: number | null;
  recoveryMedianS: number | null;
  totalMedianS: number | null;
  totalMean: Estimate | null;
  notRecovered: number;
}

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** AT-06 recovery per system: medians over the runs whose carrier was declared failed (as `npm run bench` reports). */
export function recoverySummary(rec: readonly RecoveryRow[], systems: readonly SystemId[] = RADIOMAP_SYSTEMS): RecoverySummary[] {
  return systems.map((system) => {
    const rs = rec.filter((r) => r.system === system && r.detectS !== null);
    const nn = (k: 'detectS' | 'recoveryS' | 'totalS') => rs.map((r) => r[k]).filter((v): v is number => v !== null);
    return { system, runs: rs.length, detectMedianS: median(nn('detectS')), recoveryMedianS: median(nn('recoveryS')), totalMedianS: median(nn('totalS')), totalMean: bootstrapMean(nn('totalS')), notRecovered: rs.filter((r) => r.totalS === null).length };
  });
}

export function radiomapMarkdown(rows: readonly BenchRow[], rec: readonly RecoveryRow[], o: { seeds: number; windowS: number; recoverySeeds: number; recoveryScenario: string }): string {
  const L: string[] = [];
  const cells = pairedCells(rows);
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  L.push('# Radio-shadow-aware ownership ("planned silence"): `pact` vs `pact_fixed_lease`', '');
  L.push(`${rows.length} runs: ${scenarios.length} scenario(s) x 2 systems x ${o.seeds} seed(s), ${o.windowS} s of simulated time each, identical seeds per system (run i uses the scenario seed + i). Values are means with a 95 % percentile-bootstrap CI; **Δ** is the paired per-seed difference \`pact\` − \`pact_fixed_lease\` with its own bootstrap CI. Simulation only: no claim of real-world flight readiness.`, '');
  L.push('- `pact_fixed_lease`: PACT before Decision 22: every pre-pickup lease is the fixed 20 s; the origin depot re-opens a job whose renewals stop for 20 x 1.02 + 2 s.');
  L.push('- `pact`: radio-shadow-aware ownership: drones learn a shared radio shadow map (CRDT, gossiped), forecast the longest radio-dark stretch on the way to the pickup, and announce a longer lease before they go silent (planned silence, capped at 90 s); urgent jobs prefer drones that stay in coverage (connectivity term in the bid).', '');
  L.push('**False re-opens** = lease expiries whose owner was alive (not killed or removed); in these scenarios no drone is killed, so every lease expiry is a false failover. **Planned silences** = leases announced above the base length ahead of a forecast shadow.', '');
  for (const scn of scenarios) {
    L.push(`## ${scn}`, '');
    L.push('| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |');
    L.push('|---|---|---|---|');
    for (const m of RADIOMAP_METRICS) {
      const c = cells.find((x) => x.scenario === scn && x.metric === m.key)!;
      if (m.better === 'zero') L.push(`| ${m.label} (total) | ${c.baseSum} | ${c.treatSum} | ${c.treatSum - c.baseSum >= 0 ? '+' : ''}${c.treatSum - c.baseSum} |`);
      else L.push(`| ${m.label} | ${fmt(c.base, m.digits)} | ${fmt(c.treat, m.digits)} | ${signed(c.diff, m.digits)} |`);
    }
    L.push('');
  }
  const rs = recoverySummary(rec);
  L.push(`## Recovery after a carrier failure (${o.recoveryScenario}, AT-06 measure)`, '');
  L.push(`${o.recoverySeeds} seeds per system: the first drone to pick up a parcel after 120 s is killed 10 s later. Detection = kill -> the origin depot's \`peer_failed\`; recovery = declaration -> replacement claimed by another drone. Medians over the runs where the victim still carried its parcel.`, '');
  L.push('| System | Runs | Detection median s | Recovery median s | Kill -> claimed median s | Kill -> claimed mean s | Not recovered |');
  L.push('|---|---|---|---|---|---|---|');
  const f1 = (v: number | null) => (v === null ? 'n/a' : v.toFixed(1));
  for (const r of rs) L.push(`| \`${r.system}\` | ${r.runs} | ${f1(r.detectMedianS)} | ${f1(r.recoveryMedianS)} | ${f1(r.totalMedianS)} | ${fmt(r.totalMean, 1)} | ${r.notRecovered} |`);
  L.push('');
  const fenced = rows.reduce((a, r) => a + r.duplicateDeliveries + r.zombiePickups, 0);
  L.push('## Invariants', '');
  L.push(`- I1 / I3 over all ${rows.length} runs: duplicate deliveries + zombie pickups = **${fenced}** (must be 0).`, '');
  L.push('Reproduce: `cd sim3d && npm run radiomap` (options: `--seeds=N --window=S --scenarios=a,b --recovery=N --jobs=N --out=dir`).', '');
  return L.join('\n');
}
