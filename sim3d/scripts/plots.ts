/**
 * `npm run plots` / `make plots`: renders the results plots (REQ-EVAL-004) from the files `bench` and `sweep` wrote:
 *   ../results/bench.json        -> ../results/plots/bench_on_time.svg
 *   ../results/sweep/sweep.json  -> ../results/plots/sweep_pareto.svg
 * A missing input is skipped with a note (run `make bench` / `make sweep` first). --results=dir overrides ../results.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { benchOnTimeSvg, sweepParetoSvg } from '../src/eval/plots';

const flag = process.argv.find((a) => a.startsWith('--results='));
const dir = resolve(flag ? flag.slice('--results='.length) : '../results');
const out = resolve(dir, 'plots');
mkdirSync(out, { recursive: true });
let n = 0;

const bench = resolve(dir, 'bench.json');
if (existsSync(bench)) {
  const j = JSON.parse(readFileSync(bench, 'utf8'));
  writeFileSync(resolve(out, 'bench_on_time.svg'), benchOnTimeSvg(j.rows, j));
  n++;
} else console.warn(`skip: ${bench} not found (make bench)`);

const sweep = resolve(dir, 'sweep', 'sweep.json');
if (existsSync(sweep)) {
  const j = JSON.parse(readFileSync(sweep, 'utf8'));
  writeFileSync(resolve(out, 'sweep_pareto.svg'), sweepParetoSvg(j.cells, j));
  n++;
} else console.warn(`skip: ${sweep} not found (make sweep)`);

console.log(`wrote ${n} plot(s) to ${out}`);
