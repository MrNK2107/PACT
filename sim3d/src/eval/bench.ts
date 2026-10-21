import { SimulationEngine } from '../sim/SimulationEngine';
import { SYSTEM_IDS, type SystemId } from '../sim/systems';
import type { Scenario } from '../scenario/types';
import { worldConfigFrom } from '../scenario/load';
import { createWorld } from '../world/buildWorld';
import { Rng } from '../world/rng';
import { computeMetrics, type RunMetrics } from './metrics';

/**
 * Benchmark runner (TC-12, REQ-EVAL-002): scenario x system x seed, each run headless for a fixed window of
 * simulated time, metrics from the event log (REQ-EVAL-003). Runs are sequential and deterministic: the same
 * matrix gives the same rows (wall-clock is only used for the compute-time column).
 */

export interface BenchOptions {
  scenarios: Scenario[];
  systems: readonly SystemId[];
  /** Seeds per (scenario, system); run i uses `scenario.seed + i`, so systems are paired on identical seeds. */
  seeds: number;
  windowS: number;
  onRun?: (row: BenchRow, i: number, total: number) => void;
}

export interface BenchRow extends RunMetrics {
  scenario: string;
  map: string;
  system: SystemId;
  seed: number;
  windowS: number;
  eventHash: string;
  events: number;
  tickP95Ms: number;
}

export function runOne(scn: Scenario, system: SystemId, seed: number, windowS: number): BenchRow {
  const s: Scenario = { ...scn, seed, system };
  const eng = new SimulationEngine(createWorld(worldConfigFrom(s)), s);
  eng.start();
  const steps = Math.round(windowS / 0.05);
  const times: number[] = new Array(steps);
  for (let i = 0; i < steps; i++) {
    const t0 = performance.now();
    eng.update(0.05);
    times[i] = performance.now() - t0;
  }
  times.sort((a, b) => a - b);
  const m = computeMetrics(eng.events, windowS);
  return { scenario: scn.name, map: scn.map, system, seed, windowS, ...m, eventHash: eng.eventHash(), events: eng.events.length, tickP95Ms: Math.round((times[Math.floor(steps * 0.95)] ?? 0) * 100) / 100 };
}

export function runBench(o: BenchOptions): BenchRow[] {
  const rows: BenchRow[] = [];
  const total = o.scenarios.length * o.systems.length * o.seeds;
  for (const scn of o.scenarios) {
    for (let i = 0; i < o.seeds; i++) {
      for (const sys of o.systems) {
        const row = runOne(scn, sys, scn.seed + i, o.windowS);
        rows.push(row);
        o.onRun?.(row, rows.length, total);
      }
    }
  }
  return rows;
}

// ---- statistics ---------------------------------------------------------------------------------------

export interface Estimate {
  mean: number;
  lo: number;
  hi: number;
  n: number;
}

/** Mean with a 95 % percentile-bootstrap CI (docs/05 section 5.5). Seeded, so the summary is reproducible. */
export function bootstrapMean(xs: readonly number[], resamples = 2000, seed = 1): Estimate | null {
  if (!xs.length) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (xs.length === 1) return { mean, lo: mean, hi: mean, n: 1 };
  const rng = new Rng(seed);
  const ms: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng.next() * xs.length)];
    ms.push(s / xs.length);
  }
  ms.sort((a, b) => a - b);
  return { mean, lo: ms[Math.floor(0.025 * resamples)], hi: ms[Math.min(resamples - 1, Math.floor(0.975 * resamples))], n: xs.length };
}

function vals(rows: readonly BenchRow[], key: keyof RunMetrics): number[] {
  return rows.map((r) => r[key]).filter((v): v is number => typeof v === 'number');
}

function fmt(e: Estimate | null, digits = 1): string {
  if (!e) return 'n/a';
  if (e.n === 1 || e.lo === e.hi) return e.mean.toFixed(digits);
  return `${e.mean.toFixed(digits)} [${e.lo.toFixed(digits)}, ${e.hi.toFixed(digits)}]`;
}

// ---- acceptance checks ----------------------------------------------------------------------------------

export interface Check {
  id: string;
  pass: boolean | null;
  detail: string;
}

/** Mean on-time rate of one (scenario, system) cell. */
function cellMean(rows: readonly BenchRow[], scenario: string, system: SystemId): number | null {
  const xs = vals(rows.filter((r) => r.scenario === scenario && r.system === system), 'onTimeRate');
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/**
 * AT-05 (hub kill): PACT's on-time rate on the hub-loss scenario degrades by <= 15 % vs healthy, the
 * `central_hub_loss` baseline by > 40 % (relative to its own healthy run, where the hub never dies).
 * AT-12-lite: every run finished and kept invariants I1 / I3.
 */
export function acceptanceChecks(rows: readonly BenchRow[], healthy = 's0_healthy', hubLoss = 's1_hub_loss'): Check[] {
  const out: Check[] = [];
  const ph = cellMean(rows, healthy, 'pact');
  const pl = cellMean(rows, hubLoss, 'pact');
  const ch = cellMean(rows, healthy, 'central_hub_loss');
  const cl = cellMean(rows, hubLoss, 'central_hub_loss');
  if (ph !== null && pl !== null && ch !== null && cl !== null && ph > 0 && ch > 0) {
    const pDrop = (100 * (ph - pl)) / ph;
    const cDrop = (100 * (ch - cl)) / ch;
    out.push({
      id: 'AT-05',
      pass: pDrop <= 15 && cDrop > 40,
      detail: `on-time rate, healthy -> hub loss: pact ${ph.toFixed(1)} -> ${pl.toFixed(1)} % (drop ${pDrop.toFixed(1)} %, gate <= 15 %); central_hub_loss ${ch.toFixed(1)} -> ${cl.toFixed(1)} % (drop ${cDrop.toFixed(1)} %, gate > 40 %)`,
    });
  } else out.push({ id: 'AT-05', pass: null, detail: `needs ${healthy} and ${hubLoss} with pact and central_hub_loss in the matrix` });
  const dup = rows.reduce((a, r) => a + r.duplicateDeliveries, 0);
  const zom = rows.reduce((a, r) => a + r.zombiePickups, 0);
  out.push({ id: 'AT-12 (partial)', pass: dup === 0 && zom === 0, detail: `${rows.length} runs completed; duplicate deliveries ${dup}, zombie pickups ${zom} (partition policies are not implemented, so systems stand in for policies)` });
  return out;
}

// ---- outputs --------------------------------------------------------------------------------------------

const CSV_COLS: (keyof BenchRow)[] = ['scenario', 'map', 'system', 'seed', 'windowS', 'released', 'due', 'delivered', 'onTime', 'onTimeRate', 'onTimePctOfDelivered', 'meanLatenessS', 'deliveredAfterFirstFault', 'duplicateDeliveries', 'zombiePickups', 'leaseExpiries', 'depotRefusals', 'lossOfSeparation', 'batteryDepleted', 'events', 'eventHash', 'tickP95Ms'];

export function toCsv(rows: readonly BenchRow[]): string {
  const lines = [CSV_COLS.join(',')];
  for (const r of rows) lines.push(CSV_COLS.map((c) => (r[c] === null ? '' : String(r[c]))).join(','));
  return lines.join('\n') + '\n';
}

export function summaryMarkdown(rows: readonly BenchRow[], o: { seeds: number; windowS: number }): string {
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const systems = [...new Set(rows.map((r) => r.system))].sort((a, b) => SYSTEM_IDS.indexOf(a) - SYSTEM_IDS.indexOf(b));
  const L: string[] = [];
  L.push('# PACT benchmark summary', '');
  L.push(`${rows.length} runs: ${scenarios.length} scenario(s) x ${systems.length} system(s) x ${o.seeds} seed(s), ${o.windowS} s of simulated time each.`);
  L.push('Metrics come from the event log only. Values are means with a 95 % bootstrap CI in brackets. Simulation only: no claim of real-world flight readiness.', '');
  L.push('**On-time rate** = tasks that fell due inside the window and were delivered by their deadline, divided by the tasks that fell due.', '');
  for (const scn of scenarios) {
    L.push(`## ${scn}`, '');
    L.push('| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Tick p95 ms |');
    L.push('|---|---|---|---|---|---|---|---|---|');
    for (const sys of systems) {
      const rs = rows.filter((r) => r.scenario === scn && r.system === sys);
      if (!rs.length) continue;
      const tick = Math.max(...rs.map((r) => r.tickP95Ms));
      L.push(`| \`${sys}\` | ${fmt(bootstrapMean(vals(rs, 'onTimeRate')))} | ${fmt(bootstrapMean(vals(rs, 'delivered')))} | ${fmt(bootstrapMean(vals(rs, 'deliveredAfterFirstFault')))} | ${fmt(bootstrapMean(vals(rs, 'meanLatenessS')))} | ${sum(rs, 'duplicateDeliveries')} | ${sum(rs, 'zombiePickups')} | ${sum(rs, 'lossOfSeparation')} | ${tick.toFixed(1)} |`);
    }
    L.push('');
  }
  L.push('## Acceptance checks', '');
  for (const c of acceptanceChecks(rows)) L.push(`- **${c.id}**: ${c.pass === null ? 'not evaluated' : c.pass ? 'PASS' : 'FAIL'} — ${c.detail}`);
  L.push('', '## Systems', '');
  L.push('- `pact`: decentralised bid / claim / back-off over the radio, epoch-fenced leases, depot arbitration.');
  L.push('- `central_full`: central hub, global greedy assignment every auction period, no radio limits, never fails (upper bound).');
  L.push('- `central_hub_loss`: the same hub; `kill_service(central_hub)` stops all new dispatches.');
  L.push('- `greedy_nearest`: decentralised, nearest feasible task first, no priorities, deadlines or bids.');
  L.push('');
  return L.join('\n');
}

function sum(rows: readonly BenchRow[], k: keyof RunMetrics): number {
  return rows.reduce((a, r) => a + ((r[k] as number) ?? 0), 0);
}
