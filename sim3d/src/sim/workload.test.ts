import { describe, expect, it } from 'vitest';
import { scenarioWith, worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import { createWorld } from '../world/buildWorld';
import { Rng } from '../world/rng';
import { TASK_ID_RE, type Task } from './Task';
import { WorkloadGenerator } from './WorkloadGenerator';

const SCN = getScenario('test_small');
const world = createWorld(worldConfigFrom(SCN));

describe('workload generator (REQ-SIM-005)', () => {
  it('produces Poisson arrivals at the configured rate with the configured priority mix', () => {
    const s = scenarioWith(SCN, { workload: { arrival_rate_per_min: 2.5, priority_mix: [0.1, 0.3, 0.6] } });
    const gen = new WorkloadGenerator(world, s, new Rng(123));
    const tasks: Task[] = [];
    for (let t = 0; t <= 3600; t += 0.05) tasks.push(...gen.step(t));
    expect(tasks.length).toBeGreaterThan(120);
    expect(tasks.length).toBeLessThan(180);
    const ids = new Set(tasks.map((t) => t.task_id));
    expect(ids.size).toBe(tasks.length);
    for (const t of tasks) {
      expect(t.task_id).toMatch(TASK_ID_RE);
      expect(t.deadline).toBeGreaterThanOrEqual(t.created_at + 240);
      expect(t.weight_kg).toBeLessThanOrEqual(s.fleet.capacity_kg);
      expect(t.weight_kg).toBeGreaterThan(0);
      expect(t.shard).toMatch(/^H-\d+-\d+$/);
      expect(t.state).toBe('UNASSIGNED');
      expect(t.epoch).toBe(0);
      expect(world.depots.some((d) => d.id === t.origin_depot)).toBe(true);
    }
    // deadlines follow the per-priority distribution
    for (const t of tasks) {
      const [lo, hi] = s.workload.deadline_s[t.priority];
      expect(t.deadline - t.created_at).toBeGreaterThanOrEqual(lo - 1e-6);
      expect(t.deadline - t.created_at).toBeLessThanOrEqual(hi + 1e-6);
    }
  });

  it('matches the priority mix and clusters urgent demand on hospitals / clinics', () => {
    const s = scenarioWith(SCN, { workload: { arrival_rate_per_min: 60 } });
    const gen = new WorkloadGenerator(world, s, new Rng(99));
    const tasks: Task[] = [];
    for (let t = 0; t <= 3000; t += 0.05) tasks.push(...gen.step(t));
    expect(tasks.length).toBeGreaterThan(2500);
    const frac = (p: number) => tasks.filter((t) => t.priority === p).length / tasks.length;
    expect(Math.abs(frac(1) - 0.1)).toBeLessThan(0.05);
    expect(Math.abs(frac(2) - 0.3)).toBeLessThan(0.05);
    expect(Math.abs(frac(3) - 0.6)).toBeLessThan(0.05);
    const urgent = tasks.filter((t) => t.priority === 1);
    const medical = urgent.filter((t) => t.type === 'hospital' || t.type === 'clinic').length / urgent.length;
    const hasMedical = world.clusters.some((c) => c.type === 'hospital' || c.type === 'clinic');
    if (hasMedical) expect(medical).toBeGreaterThan(0.4);
    // demand is clustered: the busiest cluster gets materially more than an even share
    const byCluster = new Map<string, number>();
    for (const t of tasks) {
      const c = world.dropPoints.find((d) => d.id === t.dropId)!.clusterId;
      byCluster.set(c, (byCluster.get(c) ?? 0) + 1);
    }
    const max = Math.max(...byCluster.values());
    expect(max).toBeGreaterThan((2 * tasks.length) / world.clusters.length);
  });

  it('is deterministic for a seed', () => {
    const a = new WorkloadGenerator(world, SCN, new Rng(5));
    const b = new WorkloadGenerator(world, SCN, new Rng(5));
    const ta: Task[] = [];
    const tb: Task[] = [];
    for (let t = 0; t <= 600; t += 0.05) {
      ta.push(...a.step(t));
      tb.push(...b.step(t));
    }
    expect(JSON.stringify(ta)).toBe(JSON.stringify(tb));
  });

  it('merges scripted tasks at their time and keeps their ids, and schedules bursts', () => {
    const s = scenarioWith(SCN, {
      workload: {
        arrival_rate_per_min: 0,
        tasks: [
          { t: 10, task_id: 'D1:00000010:abcd', origin_depot: 'D1', drop_id: world.dropPoints[3].id, priority: 1, deadline_offset_s: 300, weight_kg: 0.5 },
          { t: 20, drop: { x: world.dropPoints[5].pos.x + 3, y: world.dropPoints[5].pos.z - 2 }, priority: 2 },
          { t: 30, cluster_type: world.clusters[0].type, priority: 3 },
        ],
      },
    });
    const gen = new WorkloadGenerator(world, s, new Rng(1));
    expect(gen.step(9.99)).toHaveLength(0);
    const first = gen.step(10);
    expect(first).toHaveLength(1);
    expect(first[0].task_id).toBe('D1:00000010:abcd');
    expect(first[0].scripted).toBe(true);
    expect(first[0].deadline).toBe(310);
    expect(first[0].weight_kg).toBe(0.5);
    const second = gen.step(20);
    expect(second[0].dropId).toBe(world.dropPoints[5].id);
    const third = gen.step(30);
    expect(third[0].type).toBe(world.clusters[0].type);
    expect(gen.step(1000)).toHaveLength(0);
    gen.burst(10, 1, 60, 1000);
    const burst: Task[] = [];
    for (let t = 1000; t <= 1061; t += 0.05) burst.push(...gen.step(t));
    expect(burst).toHaveLength(10);
    for (const b of burst) {
      expect(b.priority).toBe(1);
      expect(b.created_at).toBeGreaterThanOrEqual(1000);
      expect(b.created_at).toBeLessThanOrEqual(1060);
    }
  });
});
