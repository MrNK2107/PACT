/**
 * `npm run sweep` / `make sweep`: the AT-12 policy sweep (src/eval/sweep.ts). Writes ../results/sweep/:
 *   sweep.json  every run (metrics + event hash) and the per-cell Pareto data
 *   sweep.csv   the runs, flat
 *   sweep.md    per-scenario Pareto tables with bootstrap CIs and the AT-12 check
 * Policy axis: STRICT / QUORUM / OPTIMISTIC_BOUNDED under the fenced systems (default `pact`); the unfenced
 * references (default `cbba_plain`) run once per scenario. Scenarios may be sweep variants (src/eval/sweep.ts).
 * Options (flags or env): --seeds=N (SWEEP_SEEDS, default 30), --window=S (SWEEP_WINDOW, default 900),
 *   --scenarios=a,b (SWEEP_SCENARIOS), --systems=x,y (SWEEP_SYSTEMS), --references=x,y (SWEEP_REFERENCES),
 *   --out=dir (SWEEP_OUT, default ../results/sweep).
 * Exit code 1 when AT-12 fails (a run missing, or a fenced system broke I1 / I3).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { at12Check, DEFAULT_SWEEP_SCENARIOS, type SweepCrash, POLICIES, runSweep, sweepCells, sweepCsv, sweepMarkdown, sweepScenario, sweepSize } from '../src/eval/sweep';
import { SCENARIOS } from '../src/scenario/registry';
import { SYSTEM_IDS, type SystemId } from '../src/sim/systems';

function opt(name: string, env: string, def: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : (process.env[env] ?? def);
}

const seeds = Number(opt('seeds', 'SWEEP_SEEDS', '30'));
const windowS = Number(opt('window', 'SWEEP_WINDOW', '900'));
const scenarioNames = opt('scenarios', 'SWEEP_SCENARIOS', DEFAULT_SWEEP_SCENARIOS.join(',')).split(',').filter(Boolean);
const systems = opt('systems', 'SWEEP_SYSTEMS', 'pact').split(',').filter(Boolean) as SystemId[];
const references = opt('references', 'SWEEP_REFERENCES', 'cbba_plain').split(',').filter(Boolean) as SystemId[];
const out = resolve(opt('out', 'SWEEP_OUT', '../results/sweep'));

const scenarios = scenarioNames.map((n) => sweepScenario(n, SCENARIOS));
for (const s of [...systems, ...references]) if (!SYSTEM_IDS.includes(s)) throw new Error(`unknown system ${s}; known: ${SYSTEM_IDS.join(', ')}`);

const t0 = Date.now();
const expected = sweepSize({ scenarios, systems, references, policies: POLICIES, seeds });
const crashes: SweepCrash[] = [];
const rows = runSweep({
  onError: (c) => {
    crashes.push(c);
    console.error(`run failed: ${c.scenario} ${c.policy} ${c.system} seed ${c.seed}: ${c.error}`);
  },
  scenarios,
  systems,
  references,
  policies: POLICIES,
  seeds,
  windowS,
  onRun: (r, i, total) => console.log(`[${i}/${total}] ${r.scenario} ${r.policy} ${r.system} seed ${r.seed}: on-time rate ${r.onTimeRate ?? 'n/a'} %, dup ${r.duplicateDeliveries}`),
});
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'sweep.json'), JSON.stringify({ seeds, windowS, scenarios: scenarioNames, systems, references, policies: POLICIES, crashes, cells: sweepCells(rows), rows }, null, 2) + '\n');
writeFileSync(resolve(out, 'sweep.csv'), sweepCsv(rows));
const descriptions = Object.fromEntries(scenarios.map((s) => [s.name, `${s.map}: ${s.description}`]));
let md = sweepMarkdown(rows, { seeds, windowS, expected, policies: POLICIES, descriptions });
if (crashes.length) md += ['', '## Failed runs', '', ...crashes.map((c) => `- ${c.scenario} / ${c.policy} / ${c.system} / seed ${c.seed}: ${c.error}`), ''].join('\n');
writeFileSync(resolve(out, 'sweep.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const at12 = at12Check(rows, expected);
if (!at12.pass) console.error(`AT-12 failed: ${at12.detail}`);
process.exit(at12.pass ? 0 : 1);
