/**
 * `npm run sweep` / `make sweep`: the AT-12 policy sweep (src/eval/sweep.ts). Writes ../results/sweep/:
 *   sweep.json  every run (metrics + event hash) and the per-cell Pareto data
 *   sweep.csv   the runs, flat
 *   sweep.md    per-scenario Pareto tables with bootstrap CIs and the AT-12 check
 * Options (flags or env): --seeds=N (SWEEP_SEEDS, default 30), --window=S (SWEEP_WINDOW, default 900),
 *   --scenarios=a,b (SWEEP_SCENARIOS), --systems=x,y (SWEEP_SYSTEMS), --out=dir (SWEEP_OUT, default ../results/sweep).
 * Exit code 1 when AT-12 fails (a run missing, or a fenced system broke I1 / I3).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { at12Check, type SweepCrash, POLICIES, runSweep, sweepCells, sweepCsv, sweepMarkdown } from '../src/eval/sweep';
import { SCENARIOS } from '../src/scenario/registry';
import { SYSTEM_IDS, type SystemId } from '../src/sim/systems';

function opt(name: string, env: string, def: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(name.length + 3) : (process.env[env] ?? def);
}

const seeds = Number(opt('seeds', 'SWEEP_SEEDS', '30'));
const windowS = Number(opt('window', 'SWEEP_WINDOW', '900'));
const scenarioNames = opt('scenarios', 'SWEEP_SCENARIOS', 's6_battery_crunch,dm_canyon_shadow,ip_radio_clutter').split(',').filter(Boolean);
const systems = opt('systems', 'SWEEP_SYSTEMS', 'pact,cbba_plain').split(',').filter(Boolean) as SystemId[];
const out = resolve(opt('out', 'SWEEP_OUT', '../results/sweep'));

for (const n of scenarioNames) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}; known: ${Object.keys(SCENARIOS).join(', ')}`);
for (const s of systems) if (!SYSTEM_IDS.includes(s)) throw new Error(`unknown system ${s}; known: ${SYSTEM_IDS.join(', ')}`);

const t0 = Date.now();
const expected = scenarioNames.length * systems.length * POLICIES.length * seeds;
const crashes: SweepCrash[] = [];
const rows = runSweep({
  onError: (c) => {
    crashes.push(c);
    console.error(`run failed: ${c.scenario} ${c.policy} ${c.system} seed ${c.seed}: ${c.error}`);
  },
  scenarios: scenarioNames.map((n) => SCENARIOS[n]),
  systems,
  policies: POLICIES,
  seeds,
  windowS,
  onRun: (r, i, total) => console.log(`[${i}/${total}] ${r.scenario} ${r.policy} ${r.system} seed ${r.seed}: on-time rate ${r.onTimeRate ?? 'n/a'} %, dup ${r.duplicateDeliveries}`),
});
mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, 'sweep.json'), JSON.stringify({ seeds, windowS, scenarios: scenarioNames, systems, policies: POLICIES, crashes, cells: sweepCells(rows), rows }, null, 2) + '\n');
writeFileSync(resolve(out, 'sweep.csv'), sweepCsv(rows));
let md = sweepMarkdown(rows, { seeds, windowS, expected, policies: POLICIES });
if (crashes.length) md += ['', '## Failed runs', '', ...crashes.map((c) => `- ${c.scenario} / ${c.policy} / ${c.system} / seed ${c.seed}: ${c.error}`), ''].join('\n');
writeFileSync(resolve(out, 'sweep.md'), md);
console.log(`\n${md}`);
console.log(`wrote ${out} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
const at12 = at12Check(rows, expected);
if (!at12.pass) console.error(`AT-12 failed: ${at12.detail}`);
process.exit(at12.pass ? 0 : 1);
