/**
 * `npm run radiomap`: radio-shadow-aware ownership evaluation (Decision 22). `pact` against the ablation
 * `pact_fixed_lease` on identical seeds, plus the AT-06 recovery measure for both. Writes ../results/radiomap/:
 *   radiomap.json  every run (bench rows) and every recovery row
 *   radiomap.csv   the runs, flat (bench columns)
 *   recovery.csv   the recovery rows
 *   summary.md     per-scenario tables with bootstrap CIs and paired differences, recovery medians, invariants
 * Options (flags or env): --seeds=N (RADIOMAP_SEEDS, default 30), --window=S (RADIOMAP_WINDOW, default 900),
 *   --scenarios=a,b (RADIOMAP_SCENARIOS; shipped scenarios or sweep variants such as dm_canyon_partition),
 *   --recovery=N (RADIOMAP_RECOVERY, seeds of the AT-06 recovery experiment, default 30; 0 skips it),
 *   --jobs=N (RADIOMAP_JOBS, worker processes, default: CPU count - 1, at most 12), --out=dir (RADIOMAP_OUT),
 *   --summarize (rewrite summary.md from an existing radiomap.json, no simulation).
 * Every run is independent and deterministic, so the result does not depend on --jobs.
 * Exit code 1 when a run breaks I1 / I3 or a worker fails.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { runOneWith, runRecovery, toCsv, type RecoveryRow } from '../src/eval/bench';
import { RADIOMAP_SCENARIOS, RADIOMAP_SYSTEMS, radiomapMarkdown, WARMUP_S, type RadiomapRow } from '../src/eval/radiomap';
import { sweepScenario } from '../src/eval/sweep';
import { SCENARIOS } from '../src/scenario/registry';

function opt(name: string, env: string, def: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : (process.env[env] ?? def);
}

const seeds = Number(opt('seeds', 'RADIOMAP_SEEDS', '30'));
const windowS = Number(opt('window', 'RADIOMAP_WINDOW', '900'));
const scenarioNames = opt('scenarios', 'RADIOMAP_SCENARIOS', RADIOMAP_SCENARIOS.join(',')).split(',').filter(Boolean);
const recSeeds = Number(opt('recovery', 'RADIOMAP_RECOVERY', '30'));
const jobs = Math.max(1, Number(opt('jobs', 'RADIOMAP_JOBS', String(Math.min(12, Math.max(1, cpus().length - 1))))));
const out = resolve(opt('out', 'RADIOMAP_OUT', '../results/radiomap'));
const worker = opt('worker', 'RADIOMAP_WORKER', '');
const RECOVERY_SCENARIO = 'at06_drone_failure';

type Unit = { kind: 'run'; scenario: string; system: (typeof RADIOMAP_SYSTEMS)[number]; seed: number } | { kind: 'rec'; system: (typeof RADIOMAP_SYSTEMS)[number]; i: number };

function units(): Unit[] {
  const u: Unit[] = [];
  for (const name of scenarioNames) {
    const scn = sweepScenario(name, SCENARIOS);
    for (let i = 0; i < seeds; i++) for (const system of RADIOMAP_SYSTEMS) u.push({ kind: 'run', scenario: name, system, seed: scn.seed + i });
  }
  for (let i = 0; i < recSeeds; i++) for (const system of RADIOMAP_SYSTEMS) u.push({ kind: 'rec', system, i });
  return u;
}

function runUnits(list: Unit[], log: (s: string) => void): { rows: RadiomapRow[]; recovery: RecoveryRow[] } {
  const rows: RadiomapRow[] = [];
  const recovery: RecoveryRow[] = [];
  for (const u of list) {
    if (u.kind === 'run') {
      const { row, eng } = runOneWith(sweepScenario(u.scenario, SCENARIOS), u.system, u.seed, windowS);
      const late = eng.events.filter((e) => e.type === 'lease_expired' && e.t >= WARMUP_S && e.t <= windowS + 1e-9).length;
      const r: RadiomapRow = { ...row, leaseExpiriesAfterWarmup: late, mapCells: eng.nodeOf('A01')?.radioMap?.knownCells().length ?? 0 };
      rows.push(r);
      log(`${u.scenario} ${u.system} seed ${u.seed}: on-time ${r.onTimeRate ?? 'n/a'} %, delivered ${r.delivered}, lease expiries ${r.leaseExpiries}, planned silences ${r.plannedSilences}`);
    } else {
      const base = SCENARIOS[RECOVERY_SCENARIO];
      const rr = runRecovery({ ...base, seed: base.seed + u.i }, [u.system], 1);
      recovery.push(...rr);
      log(`${RECOVERY_SCENARIO} ${u.system} seed ${base.seed + u.i}: kill -> claimed ${rr[0]?.totalS ?? 'n/a'} s`);
    }
  }
  return { rows, recovery };
}

const all = units();
if (worker) {
  // worker mode: units i, i + n, i + 2n, ... -> parts/part-i.json
  const [i, n] = worker.split('/').map(Number);
  const mine = all.filter((_, k) => k % n === i);
  const res = runUnits(mine, (s) => console.log(`[w${i}] ${s}`));
  writeFileSync(resolve(out, 'parts', `part-${i}.json`), JSON.stringify(res));
  process.exit(0);
}

if (process.argv.includes('--summarize')) {
  // rewrite summary.md from an existing radiomap.json (no simulation)
  const j = JSON.parse(readFileSync(resolve(out, 'radiomap.json'), 'utf8')) as { seeds: number; windowS: number; recoverySeeds: number; recoveryScenario: string; rows: RadiomapRow[]; recovery: RecoveryRow[] };
  const md = radiomapMarkdown(j.rows, j.recovery, { seeds: j.seeds, windowS: j.windowS, recoverySeeds: j.recoverySeeds, recoveryScenario: j.recoveryScenario });
  writeFileSync(resolve(out, 'summary.md'), md);
  console.log(md);
  process.exit(0);
}

const t0 = Date.now();
mkdirSync(resolve(out, 'parts'), { recursive: true });
const viteNode = resolve('node_modules/vite-node/vite-node.mjs');
const passthrough = [`--seeds=${seeds}`, `--window=${windowS}`, `--scenarios=${scenarioNames.join(',')}`, `--recovery=${recSeeds}`, `--out=${out}`];
console.log(`${all.length} units (${all.filter((u) => u.kind === 'run').length} runs, ${all.filter((u) => u.kind === 'rec').length} recovery experiments) on ${jobs} worker(s)`);
const procs = Array.from({ length: jobs }, (_, i) =>
  new Promise<number>((done) => {
    const p = spawn(process.execPath, [viteNode, 'scripts/radiomap.ts', `--worker=${i}/${jobs}`, ...passthrough], { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('exit', (code) => done(code ?? 1));
  }),
);
const codes = await Promise.all(procs);
if (codes.some((c) => c !== 0)) {
  console.error(`worker failed: exit codes ${codes.join(', ')}`);
  process.exit(1);
}
const rows: RadiomapRow[] = [];
const recovery: RecoveryRow[] = [];
for (let i = 0; i < jobs; i++) {
  const f = resolve(out, 'parts', `part-${i}.json`);
  if (!existsSync(f)) throw new Error(`missing ${f}`);
  const part = JSON.parse(readFileSync(f, 'utf8')) as { rows: RadiomapRow[]; recovery: RecoveryRow[] };
  rows.push(...part.rows);
  recovery.push(...part.recovery);
}
rmSync(resolve(out, 'parts'), { recursive: true, force: true });
// canonical order (independent of the worker split)
const sysIdx = (s: string) => RADIOMAP_SYSTEMS.indexOf(s as never);
rows.sort((a, b) => scenarioNames.indexOf(a.scenario) - scenarioNames.indexOf(b.scenario) || a.seed - b.seed || sysIdx(a.system) - sysIdx(b.system));
recovery.sort((a, b) => sysIdx(a.system) - sysIdx(b.system) || a.seed - b.seed);
for (const r of rows) r.tickP95Ms = 0; // wall-clock column: not reproducible, not reported here

writeFileSync(resolve(out, 'radiomap.json'), JSON.stringify({ seeds, windowS, scenarios: scenarioNames, systems: RADIOMAP_SYSTEMS, recoveryScenario: RECOVERY_SCENARIO, recoverySeeds: recSeeds, rows, recovery }, null, 2) + '\n');
writeFileSync(resolve(out, 'radiomap.csv'), toCsv(rows, ['leaseExpiriesAfterWarmup', 'mapCells']));
const recCols = ['system', 'seed', 'victim', 'task', 'tKill', 'detectS', 'recoveryS', 'totalS'] as const;
writeFileSync(resolve(out, 'recovery.csv'), [recCols.join(','), ...recovery.map((r) => recCols.map((c) => (r[c] === null ? '' : String(r[c]))).join(','))].join('\n') + '\n');
const md = radiomapMarkdown(rows, recovery, { seeds, windowS, recoverySeeds: recSeeds, recoveryScenario: RECOVERY_SCENARIO });
writeFileSync(resolve(out, 'summary.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const bad = rows.filter((r) => r.duplicateDeliveries + r.zombiePickups > 0);
for (const r of bad) console.error(`invariant broken: ${r.scenario} ${r.system} seed ${r.seed}: duplicates ${r.duplicateDeliveries}, zombie pickups ${r.zombiePickups}`);
process.exit(bad.length ? 1 : 0);
