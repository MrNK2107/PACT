# Copyright 2026 AeroPACT Contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Figures for the README from logged benchmark data (no ROS needed, only matplotlib).

Inputs:  results/results.csv and, when present, results/runs/<scenario>__<system>__s<seed>/
         events.jsonl (the per-run event logs written by `make bench`).
Outputs: docs/img/on_time_by_scenario.png, docs/img/timeline_<scenario>.png

    python tools/plot_results.py --results results --out docs/img
"""

import argparse
import csv
import json
import os
import sys

import matplotlib

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

# Fixed system order -> fixed categorical slot, so a system keeps its colour in every figure.
SYSTEMS = ['central', 'pact_quorum', 'pact_strict', 'pact_optimistic', 'cbba_plain',
           'greedy_nearest']
COLOURS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300']
COLOUR = dict(zip(SYSTEMS, COLOURS, strict=True))
SCENARIO_LABEL = {'s0_healthy': 'healthy', 's1_hub_loss': 'hub dies at 240 s',
                  's3_split_brain': '5-min split brain (300-600 s)'}
INK, MUTED, GRID = '#1f1f1e', '#6b6a64', '#e4e3df'


def style(ax):
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    for side in ('left', 'bottom'):
        ax.spines[side].set_color(MUTED)
    ax.tick_params(colors=MUTED, labelcolor=INK, labelsize=9)
    ax.grid(axis='y', color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)


def read_rows(results):
    with open(os.path.join(results, 'results.csv'), encoding='utf-8') as f:
        return list(csv.DictReader(f))


def plot_on_time(rows, out):
    scenarios = [s for s in SCENARIO_LABEL if any(r['scenario'] == s for r in rows)]
    rate = {(r['scenario'], r['system']): float(r['on_time_rate']) for r in rows}
    fig, ax = plt.subplots(figsize=(8.2, 4.2))
    n = len(SYSTEMS)
    width = 0.8 / n
    for i, sysname in enumerate(SYSTEMS):
        xs = [k + (i - (n - 1) / 2) * width for k in range(len(scenarios))]
        ys = [100 * rate.get((s, sysname), float('nan')) for s in scenarios]
        ax.bar(xs, ys, width * 0.9, color=COLOUR[sysname], label=sysname, edgecolor='white',
               linewidth=1)
        for x, y in zip(xs, ys, strict=True):
            if sysname == 'central' or y < 50:  # label the headline bars only
                ax.text(x, y + 1.5, '%.0f' % y, ha='center', va='bottom', fontsize=8, color=INK)
    ax.set_xticks(range(len(scenarios)))
    ax.set_xticklabels([SCENARIO_LABEL[s] for s in scenarios], fontsize=9)
    ax.set_ylabel('jobs delivered on time (%)', color=INK, fontsize=9)
    ax.set_ylim(0, 100)
    style(ax)
    ax.legend(ncol=3, fontsize=8, frameon=False, loc='upper center', bbox_to_anchor=(0.5, -0.1))
    ax.set_title('On-time delivery by scenario (6 drones, 30 jobs, seed 1)', loc='left',
                 fontsize=11, color=INK)
    fig.tight_layout()
    path = os.path.join(out, 'on_time_by_scenario.png')
    fig.savefig(path, dpi=140)
    plt.close(fig)
    return path


def cumulative_on_time(events_path):
    """Times at which distinct jobs were first delivered on time (re-orders count once)."""
    root_of, seen, ts = {}, set(), []
    with open(events_path, encoding='utf-8') as f:
        events = sorted((json.loads(line) for line in f if line.strip()), key=lambda e: e['t'])
    faults = []
    for e in events:
        d = e.get('data') or {}
        if e['type'] == 'TASK_CREATED':
            root_of[d['task_id']] = d.get('replaces') or d['task_id']
        elif e['type'] == 'DELIVERED' and d.get('on_time'):
            root = root_of.get(d['task_id'], d.get('replaces') or d['task_id'])
            if root not in seen:
                seen.add(root)
                ts.append(e['t'])
        elif e['type'] == 'FAULT_INJECTED':
            faults.append((e['t'], d.get('fault'), (d.get('args') or {}).get('until')))
    return ts, faults, (events[-1]['t'] if events else 0.0)


def plot_timeline(results, scenario, out):
    curves, faults, end = {}, [], 0.0
    for sysname in SYSTEMS:
        path = os.path.join(results, 'runs', '%s__%s__s1' % (scenario, sysname), 'events.jsonl')
        if os.path.exists(path):
            curves[sysname], faults, last = cumulative_on_time(path)
            end = max(end, last)
    if not curves:
        return None
    fig, ax = plt.subplots(figsize=(8.2, 4.2))
    for t, fault, until in faults:
        if fault == 'partition' and until:
            ax.axvspan(t, until, color='#f1efe9', zorder=0)
            ax.text((t + until) / 2, 1, 'radio partition', ha='center', fontsize=8, color=MUTED)
        else:
            ax.axvline(t, color=MUTED, linewidth=1, linestyle='--', zorder=1)
            label = 'hub killed' if fault == 'kill_service' else (fault or 'fault')
            ax.text(t + 8, 0.97, label.replace('_', ' '), fontsize=8, color=MUTED, va='top',
                    transform=ax.get_xaxis_transform())
    finals = []
    for sysname in SYSTEMS:
        if sysname not in curves:
            continue
        ts = curves[sysname]
        xs = [0.0] + [x for t in ts for x in (t, t)] + [end]
        ys = [0] + [y for i in range(len(ts)) for y in (i, i + 1)] + [len(ts)]
        ax.plot(xs, ys, color=COLOUR[sysname], linewidth=2, label=sysname, zorder=3)
        finals.append([len(ts), sysname])
    # Direct labels at the right edge, nudged apart so they do not collide.
    finals.sort()
    for i in range(1, len(finals)):
        finals[i][0] = max(finals[i][0], finals[i - 1][0] + 1.1)
    for y, sysname in finals:
        ax.text(end + 8, y, '%s (%d)' % (sysname, len(curves[sysname])), va='center',
                fontsize=8, color=INK)
    ax.set_xlim(0, end)
    ax.set_ylim(0, max(len(v) for v in curves.values()) + 3)
    ax.set_xlabel('simulation time (s)', color=INK, fontsize=9)
    ax.set_ylabel('jobs delivered on time (cumulative)', color=INK, fontsize=9)
    style(ax)
    ax.legend(fontsize=8, frameon=False, loc='upper left', bbox_to_anchor=(0.3, 1.0))
    ax.set_title('%s: on-time deliveries over time' % SCENARIO_LABEL.get(scenario, scenario),
                 loc='left', fontsize=11, color=INK)
    fig.tight_layout()
    fig.subplots_adjust(right=0.8)
    path = os.path.join(out, 'timeline_%s.png' % scenario)
    fig.savefig(path, dpi=140)
    plt.close(fig)
    return path


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n')[1])
    p.add_argument('--results', default='results')
    p.add_argument('--out', default=os.path.join('docs', 'img'))
    a = p.parse_args(argv)
    os.makedirs(a.out, exist_ok=True)
    written = [plot_on_time(read_rows(a.results), a.out)]
    for scenario in ('s1_hub_loss', 's3_split_brain'):
        written.append(plot_timeline(a.results, scenario, a.out))
    for w in written:
        if w:
            print('wrote', w)
    return 0


if __name__ == '__main__':
    sys.exit(main())
