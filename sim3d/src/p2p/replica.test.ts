import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import type { TaskState } from '../sim/Task';
import type { DroneStatusRecord, ShardLeaseRecord, TaskRecord } from './contracts';
import { compareTaskKey, keyRank, mergeTask, Replica, taskKey } from './replica';
import { mkTaskRecord as mkRec } from './testing/fakeNet';

const STATES: TaskState[] = ['UNASSIGNED', 'CLAIMED', 'COMMITTED', 'PICKED_UP', 'DELIVERED', 'ABORTED'];
const OWNERS = ['A01', 'A02', 'A03', 'A10'];

/** A random but plausible concurrent record: re-opens, same-epoch claims by different owners, renewals, terminals. */
function randomRecord(rng: Rng, id: string): TaskRecord {
  const epoch = rng.int(0, 3);
  const state = epoch === 0 ? 'UNASSIGNED' : rng.pick(STATES);
  const owner = state === 'UNASSIGNED' ? null : rng.pick(OWNERS);
  return mkRec(id, {
    epoch,
    state,
    owner,
    renew: state === 'UNASSIGNED' ? 0 : rng.int(0, 3),
    bid: owner === null ? null : -rng.int(1, 5),
    lease_s: owner === null ? 0 : 20,
  });
}

function randomStatus(rng: Rng): DroneStatusRecord {
  const id = rng.pick(OWNERS);
  return { drone_id: id, seq: rng.int(1, 6), pos: { x: rng.int(0, 9), y: 0, z: 0 }, soc: 0.5, mode: 'CONNECTED', bundle: [], t_local: rng.int(0, 3) };
}

function randomShard(rng: Rng): ShardLeaseRecord {
  return { shard: rng.pick(['S1', 'S2']), depot: 'D1', epoch: rng.int(0, 2), holder: rng.chance(0.3) ? null : rng.pick(OWNERS), renew: rng.int(0, 2), lease_s: 30 };
}

type Item = { k: 't'; r: TaskRecord } | { k: 's'; r: DroneStatusRecord } | { k: 'h'; r: ShardLeaseRecord };

function applyItem(rep: Replica, it: Item, now: number): void {
  if (it.k === 't') rep.mergeTask(it.r, now);
  else if (it.k === 's') rep.mergeStatus(it.r, now);
  else rep.mergeShard(it.r, now);
}

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('merge order (design section 4)', () => {
  it('compares epoch, then rank, then owner (null last), then renew', () => {
    const k = (epoch: number, state: TaskState, owner: string | null, renew: number) => taskKey(mkRec('x', { epoch, state, owner, renew }));
    expect(compareTaskKey(k(2, 'UNASSIGNED', null, 0), k(1, 'DELIVERED', 'A01', 9))).toBeGreaterThan(0);
    expect(compareTaskKey(k(1, 'COMMITTED', 'A09', 0), k(1, 'CLAIMED', 'A01', 5))).toBeGreaterThan(0);
    expect(compareTaskKey(k(1, 'CLAIMED', 'A01', 0), k(1, 'CLAIMED', 'A02', 7))).toBeGreaterThan(0);
    expect(compareTaskKey(k(1, 'CLAIMED', 'A99', 0), k(1, 'CLAIMED', null, 0))).toBeGreaterThan(0);
    expect(compareTaskKey(k(1, 'CLAIMED', 'A01', 3), k(1, 'CLAIMED', 'A01', 2))).toBeGreaterThan(0);
    expect(compareTaskKey(k(1, 'CLAIMED', 'A01', 3), k(1, 'CLAIMED', 'A01', 3))).toBe(0);
  });

  it('DELIVERED beats ABORTED at the same epoch (both terminal, rank >= 4)', () => {
    const d = mkRec('x', { epoch: 2, state: 'DELIVERED', owner: 'A02' });
    const a = mkRec('x', { epoch: 2, state: 'ABORTED', owner: 'A01' });
    expect(mergeTask(d, a).state).toBe('DELIVERED');
    expect(mergeTask(a, d).state).toBe('DELIVERED');
    expect(keyRank('ABORTED')).toBe(4);
    expect(keyRank('DELIVERED')).toBeGreaterThan(4);
    expect(keyRank('PICKED_UP')).toBe(3);
  });

  it('mergeTask is commutative, associative and idempotent (10 000 random triples)', () => {
    const rng = new Rng(7);
    const same = (x: TaskRecord, y: TaskRecord) => JSON.stringify(x) === JSON.stringify(y);
    for (let i = 0; i < 10_000; i++) {
      const a = randomRecord(rng, 't');
      const b = randomRecord(rng, 't');
      const c = randomRecord(rng, 't');
      expect(same(mergeTask(a, b), mergeTask(b, a))).toBe(true);
      expect(same(mergeTask(mergeTask(a, b), c), mergeTask(a, mergeTask(b, c)))).toBe(true);
      expect(same(mergeTask(a, a), a)).toBe(true);
      expect(same(mergeTask(mergeTask(a, b), b), mergeTask(a, b))).toBe(true);
    }
  });
});

describe('AT-02: CRDT merge properties over the replica', () => {
  it('10 000 random permutations with duplicates give the identical final replica; epochs never decrease (I2)', () => {
    const rng = new Rng(20260);
    const ids = ['D1:00000001:0001', 'D1:00000002:0002', 'D2:00000003:0003', 'D2:00000004:0004'];
    const items: Item[] = [];
    for (let i = 0; i < 40; i++) items.push({ k: 't', r: randomRecord(rng, rng.pick(ids)) });
    // explicit concurrent same-epoch claims by different owners, a re-open and a terminal pair
    items.push({ k: 't', r: mkRec(ids[0], { epoch: 4, state: 'CLAIMED', owner: 'A03', renew: 1, bid: -2, lease_s: 20 }) });
    items.push({ k: 't', r: mkRec(ids[0], { epoch: 4, state: 'CLAIMED', owner: 'A02', renew: 0, bid: -3, lease_s: 20 }) });
    items.push({ k: 't', r: mkRec(ids[1], { epoch: 5, state: 'UNASSIGNED' }) });
    items.push({ k: 't', r: mkRec(ids[2], { epoch: 3, state: 'ABORTED', owner: 'A01', renew: 2, lease_s: 20 }) });
    items.push({ k: 't', r: mkRec(ids[2], { epoch: 3, state: 'DELIVERED', owner: 'A10', renew: 1, lease_s: 20 }) });
    for (let i = 0; i < 10; i++) items.push({ k: 's', r: randomStatus(rng) });
    for (let i = 0; i < 6; i++) items.push({ k: 'h', r: randomShard(rng) });

    // reference: pure fold of every task record with mergeTask
    const fold = new Map<string, TaskRecord>();
    for (const it of items) if (it.k === 't') fold.set(it.r.task_id, fold.has(it.r.task_id) ? mergeTask(fold.get(it.r.task_id)!, it.r) : it.r);

    let reference: string | null = null;
    for (let p = 0; p < 10_000; p++) {
      const seq = shuffle(rng, items);
      const dups = rng.int(0, 10);
      for (let d = 0; d < dups; d++) seq.splice(rng.int(0, seq.length), 0, rng.pick(items));
      const rep = new Replica('X');
      const lastEpoch = new Map<string, number>();
      for (const it of seq) {
        applyItem(rep, it, 0);
        if (it.k === 't') {
          const e = rep.getTask(it.r.task_id)!.epoch;
          const prev = lastEpoch.get(it.r.task_id) ?? -Infinity;
          if (e < prev) throw new Error(`I2 violated: epoch ${prev} -> ${e}`);
          lastEpoch.set(it.r.task_id, e);
        }
      }
      const snap = JSON.stringify(rep.snapshot());
      if (reference === null) {
        reference = snap;
        expect(rep.tasks()).toEqual([...fold.keys()].sort().map((id) => fold.get(id)));
        expect(rep.getTask(ids[0])!.owner).toBe('A02'); // same-epoch concurrent claims: lower owner id wins
        expect(rep.getTask(ids[2])!.state).toBe('DELIVERED');
      } else if (snap !== reference) {
        throw new Error(`permutation ${p} diverged`);
      }
    }
  });
});

describe('replica bookkeeping', () => {
  it('local writes must be strictly greater in merge order', () => {
    const r = new Replica('A01');
    expect(r.writeTask(mkRec('t1'), 0)).toBe(true);
    expect(r.writeTask(mkRec('t1'), 1)).toBe(false);
    expect(r.writeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A01', lease_s: 20 }), 1)).toBe(true);
    expect(r.writeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A02', lease_s: 20 }), 1)).toBe(false); // A02 loses to A01
    expect(r.writeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A01', renew: 1, lease_s: 20 }), 2)).toBe(true);
    expect(r.writeStatus({ drone_id: 'A01', seq: 1, pos: { x: 0, y: 0, z: 0 }, soc: 1, mode: 'CONNECTED', bundle: [], t_local: 0 }, 0)).toBe(true);
    expect(r.writeStatus({ drone_id: 'A01', seq: 1, pos: { x: 1, y: 0, z: 0 }, soc: 1, mode: 'CONNECTED', bundle: [], t_local: 1 }, 0)).toBe(false);
    expect(r.writeShard({ shard: 'S', depot: 'D1', epoch: 1, holder: 'A01', renew: 0, lease_s: 30 }, 0)).toBe(true);
    expect(r.writeShard({ shard: 'S', depot: 'D1', epoch: 1, holder: 'A00', renew: 0, lease_s: 30 }, 0)).toBe(false);
    expect(r.writeShard({ shard: 'S', depot: 'D1', epoch: 1, holder: null, renew: 1, lease_s: 30 }, 0)).toBe(true);
  });

  it('tracks seenAt per (epoch, owner, renew), version, dirty records and the controller Task', () => {
    const r = new Replica('A01');
    r.mergeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A02', lease_s: 20 }), 5);
    expect(r.seenAt('t1')).toBe(5);
    expect(r.toTask('t1')!.lease_ttl).toBe(25);
    const v = r.version;
    expect(r.mergeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A02', lease_s: 20 }), 7)).toBe('unchanged');
    expect(r.version).toBe(v);
    expect(r.mergeTask(mkRec('t1', { epoch: 1, state: 'COMMITTED', owner: 'A02', lease_s: 20 }), 8)).toBe('updated');
    expect(r.seenAt('t1')).toBe(5); // state change alone does not renew the lease
    r.mergeTask(mkRec('t1', { epoch: 1, state: 'COMMITTED', owner: 'A02', renew: 1, lease_s: 20 }), 9);
    expect(r.seenAt('t1')).toBe(9);
    expect(r.version).toBe(v + 2);
    const d = r.takeDelta(9);
    expect(d.tasks.map((t) => t.renew)).toEqual([1]);
    expect(r.hasDirty()).toBe(false);
    r.mergeTask(mkRec('t1', { epoch: 1, state: 'PICKED_UP', owner: 'A02', renew: 1, lease_s: 20 }), 10);
    expect(r.toTask('t1')!.lease_ttl).toBeNull();
  });

  it('drops unknown fields and skips malformed records', () => {
    const r = new Replica('A01');
    const res = r.mergeDelta(
      { tasks: [{ ...mkRec('t1'), evil: 1 } as TaskRecord, { task_id: 'bad' } as unknown as TaskRecord], status: [null as unknown as DroneStatusRecord], shards: undefined },
      0,
    );
    expect(res.tasks.map((t) => t.task_id)).toEqual(['t1']);
    expect('evil' in r.getTask('t1')!).toBe(false);
    expect(r.taskIdList()).toEqual(['t1']);
  });

  it('digest exchange: one round trip converges a pair', () => {
    const a = new Replica('A');
    const b = new Replica('B');
    a.writeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A', lease_s: 20 }), 0);
    a.writeTask(mkRec('t2'), 0);
    b.writeTask(mkRec('t1'), 0);
    b.writeTask(mkRec('t3'), 0);
    b.writeStatus({ drone_id: 'B', seq: 3, pos: { x: 0, y: 0, z: 0 }, soc: 1, mode: 'CONNECTED', bundle: [], t_local: 0 }, 0);
    // A broadcasts its digest; B answers with what A lacks and asks for what it lacks
    const ans = b.answerDigest(a.digest(1), 1);
    expect(ans.delta.tasks.map((t) => t.task_id)).toEqual(['t3']);
    expect(ans.delta.status.map((s) => s.drone_id)).toEqual(['B']);
    expect(ans.want.tasks).toEqual(['t1', 't2']);
    a.mergeDelta(ans.delta, 1);
    b.mergeDelta(a.recordsFor(ans.want), 1);
    expect(JSON.stringify(a.snapshot())).toBe(JSON.stringify(b.snapshot()));
  });

  it('pruned tombstones leave gossip but a late stale record cannot resurrect the task', () => {
    const r = new Replica('A01', { tombstoneTtlS: 120 });
    r.mergeTask(mkRec('t1', { epoch: 2, state: 'CLAIMED', owner: 'A02', lease_s: 20 }), 0);
    r.mergeTask(mkRec('t1', { epoch: 2, state: 'DELIVERED', owner: 'A02', lease_s: 20 }), 10);
    expect(r.terminalAt('t1')).toBe(10);
    expect(Object.keys(r.digest(100).tasks)).toEqual(['t1']);
    expect(r.isPruned('t1', 131)).toBe(true);
    expect(Object.keys(r.digest(131).tasks)).toEqual([]);
    // late stale gossip (older epoch, same epoch pre-pickup)
    expect(r.mergeTask(mkRec('t1', { epoch: 1, state: 'CLAIMED', owner: 'A01', lease_s: 20 }), 200)).toBe('unchanged');
    expect(r.mergeTask(mkRec('t1', { epoch: 2, state: 'PICKED_UP', owner: 'A02', renew: 5, lease_s: 20 }), 200)).toBe('unchanged');
    expect(r.getTask('t1')!.state).toBe('DELIVERED');
    // a peer still holding a stale record names it in its digest: the pruned terminal record is sent back
    const stalePeer = new Replica('P');
    stalePeer.mergeTask(mkRec('t1', { epoch: 2, state: 'CLAIMED', owner: 'A02', lease_s: 20 }), 0);
    const ans = r.answerDigest(stalePeer.digest(200), 200);
    expect(ans.delta.tasks.map((t) => t.state)).toEqual(['DELIVERED']);
    // but a peer that never heard of it is not sent the pruned tombstone
    expect(r.answerDigest(new Replica('Q').digest(200), 200).delta.tasks).toEqual([]);
    // and pruned records are not pushed in deltas
    r.mergeTask(mkRec('t1', { epoch: 2, state: 'DELIVERED', owner: 'A01', lease_s: 20 }), 300); // lower owner wins tie
    expect(r.takeDelta(300).tasks).toEqual([]);
  });
});
