import { SYSTEM_IDS, type SystemId } from '../sim/systems';
import { bootstrapMean, type BenchRow, type Estimate, type RecoveryRow } from './bench';
import type { SweepCell } from './sweep';

/**
 * Results plots (REQ-EVAL-004) as standalone SVG: no plotting dependency, deterministic output, readable on GitHub.
 * Colours follow the system (fixed categorical order, never the rank) and switch to their dark-mode steps under
 * `prefers-color-scheme: dark`. Every mark carries a <title> so hovering in a browser shows its exact value; the
 * full numbers are in results/summary.md and results/sweep/sweep.md (the table views).
 */

const LIGHT: Record<SystemId, string> = { pact: '#2a78d6', central_full: '#eb6834', central_hub_loss: '#1baf7a', greedy_nearest: '#eda100', cbba_plain: '#e87ba4' };
const DARK: Record<SystemId, string> = { pact: '#3987e5', central_full: '#d95926', central_hub_loss: '#199e70', greedy_nearest: '#c98500', cbba_plain: '#d55181' };

function style(): string {
  const cls = (m: Record<SystemId, string>) => SYSTEM_IDS.map((s) => `.s-${s}{fill:${m[s]};stroke:${m[s]}}`).join('');
  return `<style>
svg{background:#fcfcfb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.t1{fill:#0b0b0b}.t2{fill:#52514e}.grid{stroke:#e4e3df;stroke-width:1}.axis{stroke:#9a9993;stroke-width:1}.pf{fill:none;stroke:#52514e;stroke-width:1.5}.ring{stroke:#fcfcfb}.legend-mark{fill:#52514e;stroke:none}
.ci{stroke-width:2;fill:none;stroke:#0b0b0b}${cls(LIGHT)}
@media (prefers-color-scheme: dark){svg{background:#1a1a19}.t1{fill:#f0efec}.t2{fill:#c3c2b7}.grid{stroke:#33332f}.axis{stroke:#6b6a64}.pf{stroke:#c3c2b7}.ring{stroke:#1a1a19}.legend-mark{fill:#c3c2b7}.ci{stroke:#f0efec}${cls(DARK)}}
</style>`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** On-time rate per system, one small-multiple panel per bench scenario, bars with 95 % CI whiskers. */
export function benchOnTimeSvg(rows: readonly BenchRow[], meta: { seeds: number; windowS: number }): string {
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const systems = SYSTEM_IDS.filter((s) => rows.some((r) => r.system === s));
  const panelW = 420;
  const labelW = 130;
  const barH = 16;
  const gap = 6;
  const panelH = 34 + systems.length * (barH + gap) + 26;
  const cols = 2;
  const W = cols * panelW + 20;
  const H = 70 + Math.ceil(scenarios.length / cols) * panelH;
  const plotW = panelW - labelW - 50;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`);
  o.push(`<title id="title">On-time rate by system and scenario</title><desc id="desc">Mean on-time rate per system with 95 % bootstrap CI, ${meta.seeds} seeds, ${meta.windowS} s window.</desc>`);
  o.push(style());
  o.push(`<text x="16" y="26" class="t1" font-size="16" font-weight="600">On-time rate by system (%)</text>`);
  o.push(`<text x="16" y="46" class="t2" font-size="12">Mean of ${meta.seeds} paired seeds, ${meta.windowS} s simulated each; whiskers are 95 % bootstrap CIs. Simulation only.</text>`);
  scenarios.forEach((scn, i) => {
    const x0 = 16 + (i % cols) * panelW;
    const y0 = 70 + Math.floor(i / cols) * panelH;
    const px = x0 + labelW;
    o.push(`<text x="${x0}" y="${y0 + 14}" class="t1" font-size="13" font-weight="600">${esc(scn)}</text>`);
    const top = y0 + 26;
    const bottom = top + systems.length * (barH + gap);
    for (const v of [0, 25, 50, 75, 100]) {
      const gx = px + (v / 100) * plotW;
      o.push(`<line x1="${gx}" y1="${top - 2}" x2="${gx}" y2="${bottom}" class="grid"/>`);
      o.push(`<text x="${gx}" y="${bottom + 14}" class="t2" font-size="10" text-anchor="middle">${v}</text>`);
    }
    o.push(`<line x1="${px}" y1="${top - 2}" x2="${px}" y2="${bottom}" class="axis"/>`);
    systems.forEach((sys, j) => {
      const xs = rows.filter((r) => r.scenario === scn && r.system === sys).map((r) => r.onTimeRate).filter((v): v is number => typeof v === 'number');
      const e = bootstrapMean(xs);
      const y = top + j * (barH + gap);
      o.push(`<text x="${px - 8}" y="${y + barH / 2 + 4}" class="t2" font-size="11" text-anchor="end">${sys}</text>`);
      if (!e) {
        o.push(`<text x="${px + 6}" y="${y + barH / 2 + 4}" class="t2" font-size="11">n/a</text>`);
        return;
      }
      const w = Math.max(1, (e.mean / 100) * plotW);
      const tip = `${scn} / ${sys}: ${e.mean.toFixed(1)} % [${e.lo.toFixed(1)}, ${e.hi.toFixed(1)}], n=${e.n}`;
      // bar anchored to the baseline, rounded only at the data end
      o.push(`<g><title>${esc(tip)}</title><path class="s-${sys}" stroke="none" d="M${px},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z"/>`);
      const lo = px + (e.lo / 100) * plotW;
      const hi = px + (e.hi / 100) * plotW;
      o.push(`<line x1="${lo}" y1="${y + barH / 2}" x2="${hi}" y2="${y + barH / 2}" class="ci"/></g>`);
      o.push(`<text x="${Math.min(px + plotW + 4, Math.max(hi, px + w) + 6)}" y="${y + barH / 2 + 4}" class="t1" font-size="11">${e.mean.toFixed(1)}</text>`);
    });
  });
  o.push('</svg>');
  return o.join('\n') + '\n';
}

/** AT-12 Pareto data: on-time rate (up) vs ownership violations per run (left), one panel per sweep scenario. */
export function sweepParetoSvg(cells: readonly SweepCell[], meta: { seeds: number; windowS: number }): string {
  const scenarios = [...new Set(cells.map((c) => c.scenario))];
  const systems = SYSTEM_IDS.filter((s) => cells.some((c) => c.system === s));
  const panelW = 440;
  const panelH = 300;
  const W = scenarios.length * panelW + 32;
  const H = panelH + 120;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`);
  o.push(`<title id="title">AT-12 policy sweep: on-time rate vs ownership violations</title><desc id="desc">Each dot is one system x policy cell, mean of ${meta.seeds} seeds.</desc>`);
  o.push(style());
  o.push(`<text x="16" y="26" class="t1" font-size="16" font-weight="600">AT-12 policy sweep: on-time rate vs ownership violations</text>`);
  o.push(`<text x="16" y="46" class="t2" font-size="12">One mark per system x partition policy, mean of ${meta.seeds} seeds x ${meta.windowS} s. Violations = duplicate deliveries + zombie pickups per run. Ringed = Pareto-optimal.</text>`);
  // legend (identity is never colour alone: the dots are also labelled with their policy)
  systems.forEach((s, i) => {
    const lx = 16 + i * 150;
    o.push(`<circle cx="${lx + 5}" cy="66" r="5" class="s-${s}"/><text x="${lx + 16}" y="70" class="t2" font-size="12">${s}</text>`);
  });
  const policies = [...new Set(cells.map((c) => c.policy))].sort();
  policies.forEach((p, k) => {
    const lx = 16 + (systems.length + k) * 150;
    o.push(`${marker(k, lx + 5, 66, 'legend-mark')}<text x="${lx + 16}" y="${70}" class="t2" font-size="12">${esc(p)}</text>`);
  });
  const vMax = Math.max(1, ...cells.map((c) => c.violations?.hi ?? 0));
  scenarios.forEach((scn, i) => {
    const x0 = 16 + i * panelW + 44;
    const y0 = 96;
    const pw = panelW - 80;
    const ph = panelH - 50;
    const cs = cells.filter((c) => c.scenario === scn);
    const ys = cs.map((c) => c.onTimeRate?.mean ?? 0);
    const yLo = Math.max(0, Math.floor((Math.min(...ys) - 10) / 10) * 10);
    const yHi = Math.min(100, Math.ceil((Math.max(...ys) + 5) / 10) * 10);
    const sx = (v: number) => x0 + (v / vMax) * pw;
    const sy = (v: number) => y0 + ph - ((v - yLo) / Math.max(1, yHi - yLo)) * ph;
    o.push(`<text x="${x0}" y="${y0 - 6}" class="t1" font-size="13" font-weight="600">${esc(scn)}</text>`);
    for (let v = yLo; v <= yHi; v += 10) {
      o.push(`<line x1="${x0}" y1="${sy(v)}" x2="${x0 + pw}" y2="${sy(v)}" class="grid"/><text x="${x0 - 6}" y="${sy(v) + 4}" class="t2" font-size="10" text-anchor="end">${v}</text>`);
    }
    const step = vMax <= 2 ? 0.5 : vMax <= 6 ? 1 : Math.ceil(vMax / 5);
    for (let v = 0; v <= vMax + 1e-9; v += step) o.push(`<text x="${sx(v)}" y="${y0 + ph + 14}" class="t2" font-size="10" text-anchor="middle">${+v.toFixed(1)}</text>`);
    o.push(`<line x1="${x0}" y1="${y0 + ph}" x2="${x0 + pw}" y2="${y0 + ph}" class="axis"/><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + ph}" class="axis"/>`);
    o.push(`<text x="${x0 + pw / 2}" y="${y0 + ph + 32}" class="t2" font-size="11" text-anchor="middle">violations per run (lower is better)</text>`);
    o.push(`<text x="${x0 - 34}" y="${y0 + ph / 2}" class="t2" font-size="11" text-anchor="middle" transform="rotate(-90 ${x0 - 34} ${y0 + ph / 2})">on-time rate % (higher is better)</text>`);
    for (const c of cs) {
      const e: Estimate | null = c.onTimeRate;
      const v = c.violations?.mean ?? 0;
      const cx = sx(v);
      const cy = sy(e?.mean ?? 0);
      const tip = `${scn} / ${c.system} / ${c.policy}: on-time ${e ? e.mean.toFixed(1) : 'n/a'} %, violations/run ${v.toFixed(2)}, delivered ${c.delivered?.mean.toFixed(1) ?? 'n/a'}, n=${c.runs}`;
      o.push(`<g><title>${esc(tip)}</title>${c.pareto ? `<circle cx="${cx}" cy="${cy}" r="9" fill="none" class="pf"/>` : ''}${marker(policies.indexOf(c.policy), cx, cy, `s-${c.system} ring`)}</g>`);
    }
  });
  o.push(`<text x="16" y="${H - 10}" class="t2" font-size="11">Colour = system, shape = partition policy (cbba_plain: unfenced reference, no policy). Hover a mark for its values; exact values, CIs and refusals: results/sweep/sweep.md.</text>`);
  o.push('</svg>');
  return o.join('\n') + '\n';
}

/** Policy k as a marker shape (circle, square, triangle, diamond), about 10 px across. */
function marker(k: number, x: number, y: number, cls: string): string {
  const a = 'style="stroke-width:1.5"';
  switch (k % 4) {
    case 0:
      return `<circle cx="${x}" cy="${y}" r="5.5" class="${cls}" ${a}/>`;
    case 1:
      return `<rect x="${x - 5}" y="${y - 5}" width="10" height="10" rx="1.5" class="${cls}" ${a}/>`;
    case 2:
      return `<path d="M${x},${y - 6.5} L${x + 6.5},${y + 5} L${x - 6.5},${y + 5} Z" class="${cls}" ${a}/>`;
    default:
      return `<path d="M${x},${y - 6.5} L${x + 6.5},${y} L${x},${y + 6.5} L${x - 6.5},${y} Z" class="${cls}" ${a}/>`;
  }
}

/**
 * Message load (REQ-EVAL-004, AT-11): mean messages per drone per minute, beacons excluded, per system, one panel per
 * bench scenario, with 95 % CI whiskers and the AT-11 budget of 120 as a reference line.
 */
export function messageLoadSvg(rows: readonly BenchRow[], meta: { seeds: number; windowS: number }, budget = 120): string {
  const scenarios = [...new Set(rows.map((r) => r.scenario))];
  const systems = SYSTEM_IDS.filter((s) => rows.some((r) => r.system === s));
  const est = (scn: string, sys: SystemId) => bootstrapMean(rows.filter((r) => r.scenario === scn && r.system === sys).map((r) => r.msgsPerDroneMin ?? 0));
  const xMax = Math.max(budget * 1.1, ...scenarios.flatMap((s) => systems.map((y) => est(s, y)?.hi ?? 0)));
  const panelW = 420;
  const labelW = 130;
  const barH = 16;
  const gap = 6;
  const panelH = 34 + systems.length * (barH + gap) + 26;
  const cols = 2;
  const W = cols * panelW + 20;
  const H = 70 + Math.ceil(scenarios.length / cols) * panelH + 20;
  const plotW = panelW - labelW - 50;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`);
  o.push(`<title id="title">Message load by system and scenario</title><desc id="desc">Messages sent per drone per minute, beacons excluded, mean of ${meta.seeds} seeds with 95 % bootstrap CI; AT-11 budget ${budget}.</desc>`);
  o.push(style());
  o.push(`<text x="16" y="26" class="t1" font-size="16" font-weight="600">Message load: messages per drone per minute (beacons excluded)</text>`);
  o.push(`<text x="16" y="46" class="t2" font-size="12">Mean of ${meta.seeds} paired seeds, ${meta.windowS} s simulated each; whiskers are 95 % bootstrap CIs; dashed line = AT-11 budget (${budget}). Simulation only.</text>`);
  scenarios.forEach((scn, i) => {
    const x0 = 16 + (i % cols) * panelW;
    const y0 = 70 + Math.floor(i / cols) * panelH;
    const px = x0 + labelW;
    const sx = (v: number) => px + (v / xMax) * plotW;
    o.push(`<text x="${x0}" y="${y0 + 14}" class="t1" font-size="13" font-weight="600">${esc(scn)}</text>`);
    const top = y0 + 26;
    const bottom = top + systems.length * (barH + gap);
    const step = xMax > 150 ? 50 : 25;
    for (let v = 0; v <= xMax + 1e-9; v += step) {
      o.push(`<line x1="${sx(v)}" y1="${top - 2}" x2="${sx(v)}" y2="${bottom}" class="grid"/>`);
      o.push(`<text x="${sx(v)}" y="${bottom + 14}" class="t2" font-size="10" text-anchor="middle">${v}</text>`);
    }
    o.push(`<line x1="${px}" y1="${top - 2}" x2="${px}" y2="${bottom}" class="axis"/>`);
    o.push(`<line x1="${sx(budget)}" y1="${top - 6}" x2="${sx(budget)}" y2="${bottom}" class="axis" stroke-dasharray="4 3"/>`);
    systems.forEach((sys, j) => {
      const e = est(scn, sys);
      const y = top + j * (barH + gap);
      o.push(`<text x="${px - 8}" y="${y + barH / 2 + 4}" class="t2" font-size="11" text-anchor="end">${sys}</text>`);
      if (!e) return;
      const w = Math.max(1, sx(e.mean) - px);
      o.push(`<g><title>${esc(`${scn} / ${sys}: ${e.mean.toFixed(1)} msgs/drone/min [${e.lo.toFixed(1)}, ${e.hi.toFixed(1)}], n=${e.n}`)}</title><path class="s-${sys}" stroke="none" d="M${px},${y} h${Math.max(0, w - 4)} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h${-Math.max(0, w - 4)} z"/>`);
      o.push(`<line x1="${sx(e.lo)}" y1="${y + barH / 2}" x2="${sx(e.hi)}" y2="${y + barH / 2}" class="ci"/></g>`);
      o.push(`<text x="${Math.min(px + plotW + 4, Math.max(sx(e.hi), px + w) + 6)}" y="${y + barH / 2 + 4}" class="t1" font-size="11">${e.mean.toFixed(0)}</text>`);
    });
  });
  o.push(`<text x="16" y="${H - 8}" class="t2" font-size="11">Baselines on the global board send claims only; pact also gossips replica deltas, digests, status, pickups and shard leases.</text>`);
  o.push('</svg>');
  return o.join('\n') + '\n';
}

/**
 * Recovery-time CDF (REQ-EVAL-004, AT-06): per system, the empirical CDF of the time from killing a carrier to the
 * first claim of its replacement (left), and from the declaration to that claim (right, the AT-06 measure).
 */
export function recoveryCdfSvg(rows: readonly RecoveryRow[], meta: { seeds: number; scenario: string; tFailedS?: number }): string {
  const systems = SYSTEM_IDS.filter((s) => rows.some((r) => r.system === s));
  const panels: { key: 'totalS' | 'recoveryS'; title: string }[] = [
    { key: 'totalS', title: 'kill -> replacement claimed (s)' },
    { key: 'recoveryS', title: 'declaration -> replacement claimed (s)' },
  ];
  const panelW = 440;
  const panelH = 300;
  const W = panels.length * panelW + 32;
  const H = panelH + 130;
  const o: string[] = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="title desc">`);
  o.push(`<title id="title">Recovery-time CDF after a carrier failure</title><desc id="desc">Empirical CDF per system over ${meta.seeds} seeds of ${esc(meta.scenario)}.</desc>`);
  o.push(style());
  o.push(`<text x="16" y="26" class="t1" font-size="16" font-weight="600">Recovery after a carrier failure (empirical CDF)</text>`);
  o.push(`<text x="16" y="46" class="t2" font-size="12">${esc(meta.scenario)}, ${meta.seeds} seeds per system: the first carrier after 120 s is killed 10 s after its pickup. Curves stay below 1 for runs never recovered.</text>`);
  systems.forEach((s, i) => {
    const lx = 16 + i * 150;
    o.push(`<rect x="${lx}" y="61" width="12" height="4" class="s-${s}"/><text x="${lx + 18}" y="68" class="t2" font-size="12">${s}</text>`);
  });
  panels.forEach((p, i) => {
    const x0 = 16 + i * panelW + 44;
    const y0 = 100;
    const pw = panelW - 80;
    const ph = panelH - 50;
    const all = rows.map((r) => r[p.key]).filter((v): v is number => typeof v === 'number');
    const xMax = Math.max(10, Math.ceil(Math.max(0, ...all) / 10) * 10);
    const sx = (v: number) => x0 + (v / xMax) * pw;
    const sy = (q: number) => y0 + ph - q * ph;
    o.push(`<text x="${x0}" y="${y0 - 8}" class="t1" font-size="13" font-weight="600">${esc(p.title)}</text>`);
    for (const q of [0, 0.25, 0.5, 0.75, 1]) o.push(`<line x1="${x0}" y1="${sy(q)}" x2="${x0 + pw}" y2="${sy(q)}" class="grid"/><text x="${x0 - 6}" y="${sy(q) + 4}" class="t2" font-size="10" text-anchor="end">${q}</text>`);
    const step = xMax <= 50 ? 10 : xMax <= 150 ? 25 : 50;
    for (let v = 0; v <= xMax + 1e-9; v += step) o.push(`<text x="${sx(v)}" y="${y0 + ph + 14}" class="t2" font-size="10" text-anchor="middle">${v}</text>`);
    o.push(`<line x1="${x0}" y1="${y0 + ph}" x2="${x0 + pw}" y2="${y0 + ph}" class="axis"/><line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y0 + ph}" class="axis"/>`);
    if (p.key === 'recoveryS' && xMax >= 30) o.push(`<line x1="${sx(30)}" y1="${y0}" x2="${sx(30)}" y2="${y0 + ph}" class="axis" stroke-dasharray="4 3"/><text x="${sx(30) + 4}" y="${y0 + 12}" class="t2" font-size="10">AT-06 median gate 30 s</text>`);
    o.push(`<text x="${x0 + pw / 2}" y="${y0 + ph + 32}" class="t2" font-size="11" text-anchor="middle">seconds</text>`);
    for (const sys of systems) {
      const rs = rows.filter((r) => r.system === sys);
      if (!rs.length) continue;
      const xs = rs.map((r) => r[p.key]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
      let d = `M${sx(0)},${sy(0)}`;
      xs.forEach((v, k) => {
        d += ` H${sx(v)} V${sy((k + 1) / rs.length)}`;
      });
      d += ` H${sx(xMax)}`;
      const med = xs.length * 2 >= rs.length ? xs[Math.ceil(rs.length / 2) - 1] : null;
      const tip = `${sys}: ${xs.length}/${rs.length} recovered; median ${med === null ? 'n/a' : `${med.toFixed(1)} s`}; values ${xs.map((v) => v.toFixed(1)).join(', ')}`;
      o.push(`<g><title>${esc(tip)}</title><path d="${d}" class="s-${sys}" style="fill:none;stroke-width:2"/></g>`);
    }
  });
  o.push(`<text x="16" y="${H - 10}" class="t2" font-size="11">pact declares from physical evidence (failure quorum); baselines re-order after a fixed ${meta.tFailedS ?? 60} s stand-in. Every system re-orders the parcel as priority 1 with a fresh window.</text>`);
  o.push('</svg>');
  return o.join('\n') + '\n';
}
