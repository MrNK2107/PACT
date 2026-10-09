import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import { makeTaskId, STATE_RANK, type Task } from './Task';
import { TaskBoard } from './TaskBoard';

function mk(id = 'D1:00000001:0001', priority: 1 | 2 | 3 = 2): Task {
  return {
    task_id: id,
    origin_depot: 'D1',
    pickup: { x: 0, y: 0, z: 0 },
    drop: { x: 100, y: 0, z: 100 },
    priority,
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

describe('task board (ownership rules, PRD 3.3 / 3.5 / 10)', () => {
  it('claims atomically with a fresh epoch and lease, then commits after T_commit', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk());
    expect(b.claim('D1:00000001:0001', 'A01', -1.5, 10)).toBe(true);
    expect(b.claim('D1:00000001:0001', 'A02', -2, 10)).toBe(false);
    const t = b.get('D1:00000001:0001')!;
    expect(t.state).toBe('CLAIMED');
    expect(t.epoch).toBe(1);
    expect(t.owner).toBe('A01');
    expect(t.lease_ttl).toBe(30);
    b.step(12);
    expect(t.state).toBe('CLAIMED');
    b.step(13);
    expect(t.state).toBe('COMMITTED');
  });

  it('expires a stale pre-pickup lease (zombie stop) and re-opens with a higher epoch', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk());
    b.claim('D1:00000001:0001', 'A01', -1, 0);
    b.renew('D1:00000001:0001', 'A01', 15);
    expect(b.get('D1:00000001:0001')!.lease_ttl).toBe(35);
    expect(b.step(34)).toHaveLength(0);
    const expired = b.step(36);
    expect(expired).toHaveLength(1);
    const t = b.get('D1:00000001:0001')!;
    expect(t.state).toBe('UNASSIGNED');
    expect(t.owner).toBeNull();
    expect(t.epoch).toBe(2);
    // the old owner's pickup with its stale epoch is refused (fencing token)
    expect(b.pickup('D1:00000001:0001', 'A01', 1, 40)).toBe('TASK_TAKEN');
    expect(b.claim('D1:00000001:0001', 'A02', -1, 40)).toBe(true);
    expect(b.get('D1:00000001:0001')!.epoch).toBe(3);
    expect(b.pickup('D1:00000001:0001', 'A01', 1, 41)).toBe('TASK_TAKEN');
    expect(b.pickup('D1:00000001:0001', 'A02', 3, 41)).toBe('PICKUP_GRANT');
  });

  it('makes ownership sticky after pickup and completes only for the owner', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk());
    b.claim('D1:00000001:0001', 'A01', -1, 0);
    expect(b.pickup('D1:00000001:0001', 'A01', 1, 5)).toBe('PICKUP_GRANT');
    const t = b.get('D1:00000001:0001')!;
    expect(t.lease_ttl).toBeNull();
    b.step(500); // far beyond any lease: must NOT re-open
    expect(t.state).toBe('PICKED_UP');
    b.complete('D1:00000001:0001', 'A02', 600);
    expect(t.state).toBe('PICKED_UP');
    b.complete('D1:00000001:0001', 'A01', 600);
    expect(t.state).toBe('DELIVERED');
    expect(b.stats(600).delivered).toBe(1);
    expect(b.stats(600).onTime).toBe(1);
  });

  it('release re-opens a pre-pickup task; an in-flight abort re-orders a replacement parcel', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk());
    b.claim('D1:00000001:0001', 'A01', -1, 0);
    b.release('D1:00000001:0001', 'A01', 2);
    expect(b.get('D1:00000001:0001')!.state).toBe('UNASSIGNED');
    expect(b.get('D1:00000001:0001')!.epoch).toBe(2);
    b.claim('D1:00000001:0001', 'A03', -1, 3);
    b.pickup('D1:00000001:0001', 'A03', 3, 5);
    const re = b.abortInFlight('D1:00000001:0001', 70, 'A03 declared failed')!;
    expect(b.get('D1:00000001:0001')!.state).toBe('ABORTED');
    expect(re.state).toBe('UNASSIGNED');
    expect(re.reorderOf).toBe('D1:00000001:0001');
    expect(re.dropId).toBe('DP-0001');
    expect(b.stats(80).reordered).toBe(1);
  });

  it('keeps epoch and state rank monotonic over random operation sequences', () => {
    const rng = new Rng(77);
    for (let run = 0; run < 30; run++) {
      const b = new TaskBoard({ leaseTtlS: 5, tCommitS: 2 });
      const id = makeTaskId('D2', run, rng);
      b.add(mk(id, 1));
      let epoch = 0;
      let rank = 0;
      let now = 0;
      for (let k = 0; k < 60; k++) {
        now += rng.range(0, 4);
        const drone = rng.pick(['A01', 'A02', 'A03']);
        const op = rng.int(0, 5);
        const t = b.get(id)!;
        if (op === 0) b.claim(id, drone, -rng.next(), now);
        else if (op === 1) b.renew(id, drone, now);
        else if (op === 2) b.pickup(id, drone, t.epoch, now);
        else if (op === 3) b.release(id, drone, now);
        else if (op === 4) b.complete(id, drone, now);
        else b.step(now);
        expect(t.epoch).toBeGreaterThanOrEqual(epoch);
        epoch = t.epoch;
        // rank may only drop when the epoch rises (re-open) — never within an epoch
        const r = STATE_RANK[t.state];
        if (t.epoch === epoch && r < rank) expect(t.state === 'UNASSIGNED' && t.epoch > 0).toBe(true);
        rank = r;
        if (t.state === 'DELIVERED') break;
      }
    }
  });

  it('bumps the urgent counter only for priority-1 arrivals', () => {
    const b = new TaskBoard({ leaseTtlS: 20, tCommitS: 3 });
    b.add(mk('D1:00000001:0001', 3));
    expect(b.urgentCounter).toBe(0);
    b.add(mk('D1:00000002:0001', 1));
    expect(b.urgentCounter).toBe(1);
  });
});
