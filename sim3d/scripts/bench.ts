/**
 * `npm run bench` / `make bench`: scenario x system x seed benchmark (TC-11 / TC-12). Writes ../results/:
 *   bench.json   every run (metrics + event hash)
 *   results.csv  the same, flat (stands in for results.parquet; docs/DECISIONS.md)
 *   summary.md   per-scenario tables with bootstrap CIs, the AT-05 check and the I1 / I3 invariant check
 *   recovery.json AT-06-style carrier kill per system x seed on at06_drone_failure (recovery-time CDF input)
 * Options (flags or env): --seeds=N (BENCH_SEEDS, default 5), --window=S (BENCH_WINDOW, default 900),
 *   --scenarios=a,b (BENCH_SCENARIOS), --systems=x,y (BENCH_SYSTEMS), --out=dir (BENCH_OUT, default ../results),
 *   --recovery=N (BENCH_RECOVERY, seeds of the recovery experiment, default 8; 0 skips it).
 * Exit code 1 when a run breaks an invariant (I1 / I3); with --strict (BENCH_STRICT=1) also when AT-05 fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptanceChecks, runBench, runRecovery, summaryMarkdown, toCsv, type RecoveryRow } from '../src/eval/bench';
import { SCENARIOS } from '../src/scenario/registry';
import { SYSTEM_IDS, type SystemId } from '../src/sim/systems';

function opt(name: string, env: string, def: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : (process.env[env] ?? def);
}

const seeds = Number(opt('seeds', 'BENCH_SEEDS', '5'));
const windowS = Number(opt('window', 'BENCH_WINDOW', '900'));
const scenarioNames = opt('scenarios', 'BENCH_SCENARIOS', 's0_healthy,s1_hub_loss,s6_battery_crunch,s7_urgent_burst').split(',').filter(Boolean);
const systems = opt('systems', 'BENCH_SYSTEMS', SYSTEM_IDS.join(',')).split(',').filter(Boolean) as SystemId[];
const out = resolve(opt('out', 'BENCH_OUT', '../results'));

for (const n of scenarioNames) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(', ')}`);
for (const s of systems) if (!SYSTEM_IDS.includes(s)) throw new Error(`unknown system ${s}; known: ${SYSTEM_IDS.join(', ')}`);

const t0 = Date.now();
const rows = runBench({
  scenarios: scenarioNames.map((n) => SCENARIOS[n]),
  systems,
  seeds,
  windowS,
  onRun: (r, i, total) => console.log(`[${i}/${total}] ${r.scenario} ${r.system} seed ${r.seed}: delivered ${r.delivered}, on-time rate ${r.onTimeRate ?? 'n/a'} %`),
});
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'bench.json'), JSON.stringify({ seeds, windowS, scenarios: scenarioNames, systems, rows }, null, 2) + '\n');
writeFileSync(resolve(out, 'results.csv'), toCsv(rows));
let md = summaryMarkdown(rows, { seeds, windowS });
const recSeeds = Number(opt('recovery', 'BENCH_RECOVERY', '8'));
if (recSeeds > 0) {
  const scn = SCENARIOS['at06_drone_failure'];
  const rec = runRecovery(scn, systems, recSeeds);
  writeFileSync(resolve(out, 'recovery.json'), JSON.stringify({ scenario: scn.name, seeds: recSeeds, rows: rec }, null, 2) + '\n');
  md += recoveryMarkdown(rec, scn.name, recSeeds);
}
writeFileSync(resolve(out, 'summary.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const strict = process.argv.includes('--strict') || process.env.BENCH_STRICT === '1';
const failed = acceptanceChecks(rows).filter((c) => c.pass === false && (strict || c.id !== 'AT-05'));
for (const c of failed) console.error(`${c.id} failed: ${c.detail}`);
process.exit(failed.length ? 1 : 0);

function recoveryMarkdown(rec: RecoveryRow[], scenario: string, seeds: number): string {
  const L = ['', '## Recovery after a carrier failure (AT-06 measure, every system)', ''];
  L.push(`${scenario}, ${seeds} seeds per system: the first drone to pick up a parcel after 120 s is killed 10 s later. Detection = kill -> declaration (pact: the origin depot's \`peer_failed\`; baselines: the fixed ${'`SIM.tFailed`'} stand-in). Recovery = declaration -> replacement claimed by another drone. Medians over the runs where the victim still carried its parcel.`, '');
  L.push('| System | Runs | Detection median s | Recovery median s | Kill -> claimed median s | Not recovered |');
  L.push('|---|---|---|---|---|---|');
  const med = (xs: number[]) => {
    if (!xs.length) return 'n/a';
    const s = [...xs].sort((a, b) => a - b);
    return (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2).toFixed(1);
  };
  for (const sys of [...new Set(rec.map((r) => r.system))]) {
    const rs = rec.filter((r) => r.system === sys && r.detectS !== null);
    const nn = (k: 'detectS' | 'recoveryS' | 'totalS') => rs.map((r) => r[k]).filter((v): v is number => v !== null);
    L.push(`| \`${sys}\` | ${rs.length} | ${med(nn('detectS'))} | ${med(nn('recoveryS'))} | ${med(nn('totalS'))} | ${rs.filter((r) => r.totalS === null).length} |`);
  }
  L.push('');
  return L.join('\n');
}
