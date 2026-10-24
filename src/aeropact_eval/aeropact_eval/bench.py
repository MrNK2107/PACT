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
Benchmark runner (REQ-EVAL-002).

Scenario x system x seed, one run at a time (memory-bounded), each a headless launch of the full
ROS 2 stack on the kinematic backend. Writes per-run metrics, results.csv, summary.md and plots
(Pareto, recovery CDF, message load) to the output directory.
"""

import argparse
import csv
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import time

import yaml

DEFAULT_MATRIX = {
    'scenarios': ['s0_healthy', 's1_hub_loss', 's3_split_brain', 's5_drone_failure'],
    'systems': ['pact_quorum', 'pact_strict', 'pact_optimistic', 'cbba_plain', 'greedy_nearest',
                'central'],
    'time_scale': 3.0,
}

COLUMNS = ['scenario', 'system', 'seed', 'jobs_eligible', 'on_time_rate', 'completion_rate',
           'duplicate_rate', 'duplicate_deliveries', 'duplicate_dispatches', 'median_recovery_s',
           'msgs_per_drone_min', 'collisions', 'nfz_violations', 'invariants_ok', 'wall_s']


def run_one(scenario, system, seed, out_root, time_scale, timeout_s):
    run_dir = os.path.join(out_root, 'runs', '%s__%s__s%d' % (scenario, system, seed))
    if os.path.exists(os.path.join(run_dir, 'metrics.json')):
        with open(os.path.join(run_dir, 'metrics.json'), encoding='utf-8') as f:
            return json.load(f), 0.0
    # A directory without metrics is an interrupted run. Start it from scratch: the event recorder
    # appends, and a rerun on top of a partial log would interleave two simulations.
    shutil.rmtree(run_dir, ignore_errors=True)
    os.makedirs(run_dir, exist_ok=True)
    cmd = ['ros2', 'launch', 'aeropact_bringup', 'scenario.launch.py',
           'scenario:=%s' % scenario, 'system:=%s' % system, 'seed:=%d' % seed,
           'backend:=kinematic', 'time_scale:=%s' % time_scale, 'run_dir:=%s' % run_dir]
    start = time.time()
    with open(os.path.join(run_dir, 'launch.log'), 'w', encoding='utf-8') as log:
        try:
            subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout_s,
                           check=False)
        except subprocess.TimeoutExpired:
            log.write('\nTIMEOUT after %.0fs\n' % timeout_s)
    wall = time.time() - start
    path = os.path.join(run_dir, 'metrics.json')
    if not os.path.exists(path):
        return None, wall
    with open(path, encoding='utf-8') as f:
        return json.load(f), wall


def ci95(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, None
    if len(xs) == 1:
        return xs[0], 0.0
    return statistics.mean(xs), 1.96 * statistics.stdev(xs) / math.sqrt(len(xs))


def fmt(mean, half, pct=False):
    if mean is None:
        return 'n/a'
    if pct:
        return '%.1f%% +/- %.1f' % (100 * mean, 100 * half)
    return '%.1f +/- %.1f' % (mean, half)


def write_summary(rows, out):
    groups = {}
    for r in rows:
        groups.setdefault((r['scenario'], r['system']), []).append(r)
    lines = ['# AeroPACT benchmark summary', '',
             'Simulation results indicate relative merit, not real-world performance '
             '(assumption E1). Mean +/- 95% CI over seeds.', '',
             '| scenario | system | runs | on-time | completion | duplicate rate | '
             'median recovery (s) | msgs/drone/min | invariants |',
             '|---|---|---|---|---|---|---|---|---|']
    for (scenario, system), rs in sorted(groups.items()):
        ot = ci95([r['on_time_rate'] for r in rs])
        cp = ci95([r['completion_rate'] for r in rs])
        du = ci95([r['duplicate_rate'] for r in rs])
        rc = ci95([r['median_recovery_s'] for r in rs])
        ms = ci95([r['msgs_per_drone_min'] for r in rs])
        ok = sum(1 for r in rs if r['invariants_ok'])
        lines.append('| %s | %s | %d | %s | %s | %s | %s | %s | %d/%d |' % (
            scenario, system, len(rs), fmt(*ot, pct=True), fmt(*cp, pct=True),
            fmt(*du, pct=True), fmt(*rc), fmt(*ms), ok, len(rs)))
    with open(os.path.join(out, 'summary.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')


def plot(rows, out):
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
    except ImportError:
        return
    systems = sorted({r['system'] for r in rows})
    fig, ax = plt.subplots(figsize=(6, 4.5))
    for s in systems:
        rs = [r for r in rows if r['system'] == s and r['completion_rate'] is not None]
        if rs:
            ax.scatter([100 * r['duplicate_rate'] for r in rs],
                       [100 * r['completion_rate'] for r in rs], label=s, alpha=0.75)
    ax.set_xlabel('duplicate deliveries (% of jobs)')
    ax.set_ylabel('completion (% of eligible jobs)')
    ax.set_title('Availability vs duplicate risk')
    ax.legend(fontsize=8)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'pareto.png'), dpi=130)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 4))
    for s in systems:
        xs = sorted(x for r in rows if r['system'] == s for x in r.get('_recovery', []))
        if xs:
            ax.step(xs, [(i + 1) / len(xs) for i in range(len(xs))], where='post', label=s)
    ax.set_xlabel('recovery time after DECLARED_FAILED (s)')
    ax.set_ylabel('CDF')
    ax.grid(alpha=0.3)
    if ax.get_legend_handles_labels()[0]:
        ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'recovery_cdf.png'), dpi=130)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(6, 4))
    vals = [statistics.mean([r['msgs_per_drone_min'] for r in rows
                             if r['system'] == s and r['msgs_per_drone_min'] is not None] or [0])
            for s in systems]
    ax.bar(systems, vals)
    ax.axhline(120, color='r', linestyle='--', label='M6 target (120)')
    ax.set_ylabel('frames per drone per minute')
    ax.tick_params(axis='x', rotation=30)
    ax.legend(fontsize=8)
    fig.tight_layout()
    fig.savefig(os.path.join(out, 'messages.png'), dpi=130)
    plt.close(fig)


def main(argv=None):
    p = argparse.ArgumentParser(description='AeroPACT benchmark runner')
    p.add_argument('--matrix', help='YAML with scenarios, systems, time_scale')
    p.add_argument('--seeds', type=int, default=3)
    p.add_argument('--first-seed', type=int, default=1)
    p.add_argument('--out', default='results')
    p.add_argument('--timeout', type=float, default=0.0, help='per-run wall timeout (s)')
    a = p.parse_args(argv)
    matrix = dict(DEFAULT_MATRIX)
    if a.matrix:
        with open(a.matrix, encoding='utf-8') as f:
            matrix.update(yaml.safe_load(f))
    os.makedirs(a.out, exist_ok=True)
    rows = []
    for scenario in matrix['scenarios']:
        for system in matrix['systems']:
            for seed in range(a.first_seed, a.first_seed + a.seeds):
                timeout = a.timeout or 1800.0
                print('[bench] %s / %s / seed %d ...' % (scenario, system, seed), flush=True)
                m, wall = run_one(scenario, system, seed, a.out, matrix['time_scale'], timeout)
                if m is None:
                    print('[bench]   FAILED (no metrics)', flush=True)
                    continue
                row = {'scenario': scenario, 'system': system, 'seed': seed, 'wall_s': wall,
                       'invariants_ok': m['invariants']['ok'],
                       '_recovery': m.get('recovery_times_s', [])}
                for c in COLUMNS:
                    if c in m:
                        row[c] = m[c]
                rows.append(row)
                print('[bench]   on-time %s duplicates %s (%.0fs)'
                      % (m['on_time_rate'], m['duplicate_deliveries'], wall), flush=True)
    with open(os.path.join(a.out, 'results.csv'), 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS, extrasaction='ignore')
        w.writeheader()
        for r in rows:
            w.writerow(r)
    write_summary(rows, a.out)
    plot(rows, a.out)
    print('[bench] wrote %s' % os.path.join(a.out, 'summary.md'))
    return 0 if rows else 1


if __name__ == '__main__':
    sys.exit(main())
