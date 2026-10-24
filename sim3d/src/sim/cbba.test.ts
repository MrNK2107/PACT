import { describe, expect, it } from 'vitest';
import { worldConfigFrom } from '../scenario/load';
import { getScenario } from '../scenario/registry';
import type { Scenario } from '../scenario/types';
import { createWorld } from '../world/buildWorld';
import { SimulationEngine } from './SimulationEngine';
import { allocationOf, isFenced, SYSTEM_IDS } from './systems';
import type { Task } from './Task';
import { TaskBoard } from './TaskBoard';

/** `cbba_plain` baseline: the same radio auction as PACT on an unfenced board (no atomic claim, leases or arbitration). */

function mk(id: string): Task {
  return {
    task_id: id,
    origin_depot: 'D1',
    pickup: { x: 0, y: 0, z: 0 },
    drop: { x: 100, y: 0, z: 100 },
    priority: 2,
    deadline: 900,
    weight_kg: 1,
    shard: 'H-64-64',
    state: 'UNASSIGNED',
    epoch: 0,
    owner: null,
    bid: null,
    lease_ttl: null,
    created_at: 0,
    dropId: 'DP-0001',
    type: 'residential',
    scripted: false,
  };
}

describe('cbba_plain system', () => {
  it('is registered, unfenced and uses its own allocation mode', () => {
    expect(SYSTEM_IDS).toContain('cbba_plain');
    expect(allocationOf('cbba_plain')).toBe('cbba');
    expect(isFenced('cbba_plain')).toBe(false);
    for (const s of SYSTEM_IDS.filter((x) => x !== 'cbba_plain')) expect(isFenced(s)).toBe(true);
  });
});

describe('unfenced task board', () => {
  it('a fenced board still rejects a second claim (PACT unchanged)', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk('T1'));
    expect(b.claim('T1', 'A', 1, 0)).toBe(true);
    expect(b.claim('T1', 'B', 1, 0)).toBe(false);
    expect(b.holds('T1', 'B')).toBe(false);
  });

  it('lets a second drone co-claim, hands both a parcel and logs the duplicate delivery', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3, fenced: false });
    b.add(mk('T1'));
    expect(b.claim('T1', 'A', 1, 0)).toBe(true);
    expect(b.claim('T1', 'B', 2, 1)).toBe(true);
    expect(b.holds('T1', 'A') && b.holds('T1', 'B')).toBe(true);
    expect(b.pickup('T1', 'A', 1, 5)).toBe('PICKUP_GRANT');
    expect(b.pickup('T1', 'B', 0, 6)).toBe('PICKUP_GRANT'); // no depot arbitration, stale epoch or not
    b.complete('T1', 'A', 50);
    b.complete('T1', 'B', 60);
    const del = b.events.filter((e) => e.type === 'DELIVERED');
    expect(del.map((e) => e.agent)).toEqual(['A', 'B']);
    expect(del[1].data).toMatchObject({ duplicate: true });
    expect(b.get('T1')!.state).toBe('DELIVERED');
  });

  it('has no leases: a silent owner never loses the task', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3, fenced: false });
    b.add(mk('T1'));
    b.claim('T1', 'A', 1, 0);
    for (let t = 1; t <= 200; t++) expect(b.step(t)).toEqual([]);
    expect(b.get('T1')!.state).toBe('COMMITTED');
    expect(b.events.some((e) => e.type === 'LEASE_EXPIRED')).toBe(false);
  });

  it('a task held by a drone I can hear is not free; one held out of radio range is', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3, fenced: false });
    b.add(mk('T1'));
    b.add(mk('T2'));
    b.claim('T1', 'A', 1, 0);
    expect(b.believedOpen(new Set(['A']), 'B').map((t) => t.task_id)).toEqual(['T2']);
    expect(b.believedOpen(new Set(), 'B').map((t) => t.task_id)).toEqual(['T1', 'T2']);
    expect(b.believedOpen(new Set(), 'A').map((t) => t.task_id)).toEqual(['T2']); // my own claim
  });

  it('releasing the owner hands the task to a co-claimant instead of re-opening it', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3, fenced: false });
    b.add(mk('T1'));
    b.claim('T1', 'A', 1, 0);
    b.claim('T1', 'B', 1, 0);
    b.release('T1', 'A', 2);
    expect(b.get('T1')!.owner).toBe('B');
    expect(b.holds('T1', 'B')).toBe(true);
    expect(b.holds('T1', 'A')).toBe(false);
    b.release('T1', 'B', 3);
    expect(b.get('T1')!.state).toBe('UNASSIGNED');
  });
});

describe('cbba_plain in the engine', () => {
  const BASE = getScenario('test_small');
  const run = (seconds: number) => {
    const s: Scenario = { ...BASE, system: 'cbba_plain' };
    const eng = new SimulationEngine(createWorld(worldConfigFrom(s)), s);
    eng.start();
    for (let i = 0; i < seconds * 20; i++) eng.update(0.05);
    return eng;
  };

  it('delivers parcels, never expires a lease and is deterministic (AT-01)', { timeout: 60000 }, () => {
    const eng = run(300);
    expect(eng.board.fenced).toBe(false);
    expect(eng.events.filter((e) => e.type === 'delivered').length).toBeGreaterThanOrEqual(3);
    expect(eng.events.some((e) => e.type === 'lease_expired')).toBe(false);
    expect(run(90).eventHash()).toBe(run(90).eventHash());
  });
});
