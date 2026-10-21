/**
 * `npm run bench` / `make bench`: scenario x system x seed benchmark (TC-11 / TC-12). Writes ../results/:
 *   bench.json   every run (metrics + event hash)
 *   results.csv  the same, flat (stands in for results.parquet; docs/DECISIONS.md)
 *   summary.md   per-scenario tables with bootstrap CIs and the AT-05 / AT-12 checks
 * Options (flags or env): --seeds=N (BENCH_SEEDS, default 5), --window=S (BENCH_WINDOW, default 900),
 *   --scenarios=a,b (BENCH_SCENARIOS), --systems=x,y (BENCH_SYSTEMS), --out=dir (BENCH_OUT, default ../results).
 * Exit code 1 when AT-05 or the invariant check fails.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptanceChecks, runBench, summaryMarkdown, toCsv } from '../src/eval/bench';
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
const md = summaryMarkdown(rows, { seeds, windowS });
writeFileSync(resolve(out, 'summary.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const checks = acceptanceChecks(rows);
process.exit(checks.some((c) => c.pass === false) ? 1 : 0);
