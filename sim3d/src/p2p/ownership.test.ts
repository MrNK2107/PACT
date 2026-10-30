import { describe, expect, it } from 'vitest';
import { Rng } from '../world/rng';
import type { FleetView, LeaseParams, NodeId, ShardLeaseRecord, TaskRecord } from './contracts';
import {
  abortRecord,
  claimDecision,
  claimRecord,
  commitRecord,
  compareTaskRecords,
  createPartitionPolicy,
  DEFAULT_LEASE_PARAMS,
  DEFAULT_SHARD_LEASE_PARAMS,
  deliveredRecord,
  depotAcceptHandBack,
  depotPickup,
  depotShardLeaseDecision,
  depotShardLeaseLive,
  handBackShardLease,
  holderShardLeaseLapsed,
  mergeTaskRecords,
  observerLeaseExpired,
  observerReopen,
  OwnerLeaseTracker,
  ownerLeaseLapsed,
  quorumHolds,
  releaseRecord,
  renewRecord,
  reopenRecord,
  replacementRecord,
  resolveAfterMerge,
  ShardLeaseHolder,
  type ShardLeaseParams,
} from './ownership';

const P = DEFAULT_LEASE_PARAMS;

function rec(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    task_id: 'D1:00000001:0001',
    origin_depot: 'D1',
    pickup: { x: 0, y: 0, z: 0 },
    drop: { x: 100, y: 0, z: 100 },
    priority: 2,
    deadline: 900,
    weight_kg: 1,
    shard: 'H-1',
    state: 'UNASSIGNED',
    epoch: 0,
    owner: null,
    bid: null,
    renew: 0,
    lease_s: 20,
    created_at: 0,
    dropId: 'DP-0001',
    type: 'residential',
    scripted: false,
    ...over,
  };
}

// ---- transitions ----------------------------------------------------------------------------------------------

describe('ownership record transitions (P2P_DESIGN 6)', () => {
  it('claim: epoch + 1, CLAIMED, owner, bid, renew 0, lease_s; only from UNASSIGNED', () => {
    const c = claimRecord(rec({ epoch: 4, renew: 7 }), 'A01', -12.5, 20)!;
    expect(c).toMatchObject({ state: 'CLAIMED', epoch: 5, owner: 'A01', bid: -12.5, renew: 0, lease_s: 20 });
    expect(claimRecord(c, 'A02', -1)).toBeNull();
    expect(compareTaskRecords(c, rec({ epoch: 4, renew: 7 }))).toBeGreaterThan(0);
  });

  it('concurrent claims in two partitions: equal epochs, merge keeps the lower owner id', () => {
    const base = rec({ epoch: 2 });
    const a = claimRecord(base, 'A03', -1)!;
    const b = claimRecord(base, 'A01', -9)!;
    expect(mergeTaskRecords(a, b).owner).toBe('A01');
    expect(mergeTaskRecords(b, a).owner).toBe('A01');
  });

  it('commit only by the owner, only after tCommitS local, only from CLAIMED', () => {
    const c = claimRecord(rec(), 'A01', -1)!;
    expect(commitRecord(c, 'A01', 100, 102.9, P)).toBeNull();
    expect(commitRecord(c, 'A02', 100, 104, P)).toBeNull();
    const m = commitRecord(c, 'A01', 100, 103, P)!;
    expect(m.state).toBe('COMMITTED');
    expect(compareTaskRecords(m, c)).toBeGreaterThan(0);
    expect(commitRecord(m, 'A01', 100, 110, P)).toBeNull();
  });

  it('renew: owner only, pre-pickup only, renew + 1', () => {
    const c = claimRecord(rec(), 'A01', -1)!;
    const r = renewRecord(c, 'A01')!;
    expect(r.renew).toBe(1);
    expect(renewRecord(c, 'A02')).toBeNull();
    expect(renewRecord({ ...c, state: 'PICKED_UP' }, 'A01')).toBeNull();
  });

  it('observer re-open needs the observer bound, is refused to the owner, and concurrent re-opens are equal', () => {
    const c = claimRecord(rec({ epoch: 3 }), 'A01', -1)!;
    const bound = 20 * 1.02 + 2;
    expect(observerReopen(c, 'A02', 50, 50 + bound - 0.001, P)).toBeNull();
    const x = observerReopen(c, 'A02', 50, 50 + bound + 0.01, P)!;
    const y = observerReopen(c, 'D1', 7, 7 + bound + 5, P)!;
    expect(x).toMatchObject({ state: 'UNASSIGNED', epoch: 5, owner: null, bid: null, renew: 0 });
    expect(compareTaskRecords(x, y)).toBe(0);
    expect(observerReopen(c, 'A01', 0, 1000, P)).toBeNull();
    expect(observerReopen({ ...c, state: 'PICKED_UP' }, 'A02', 0, 1000, P)).toBeNull(); // point of no return
  });

  it('release: owner only, pre-pickup only', () => {
    const c = claimRecord(rec(), 'A01', -1)!;
    expect(releaseRecord(c, 'A02')).toBeNull();
    expect(releaseRecord(c, 'A01')).toMatchObject({ state: 'UNASSIGNED', epoch: 2, owner: null });
    expect(releaseRecord({ ...c, state: 'PICKED_UP' }, 'A01')).toBeNull();
  });

  it('delivered by the owner of a PICKED_UP record; abort + replacement', () => {
    const p = rec({ state: 'PICKED_UP', epoch: 2, owner: 'A01' });
    expect(deliveredRecord(p, 'A02')).toBeNull();
    const d = deliveredRecord(p, 'A01')!;
    expect(d.state).toBe('DELIVERED');
    expect(abortRecord(d)).toBeNull();
    const ab = abortRecord(p)!;
    expect(ab.state).toBe('ABORTED');
    expect(compareTaskRecords(ab, p)).toBeGreaterThan(0);
    expect(mergeTaskRecords(ab, d).state).toBe('DELIVERED'); // rank tie -> DELIVERED
    const r = replacementRecord(ab, 2, 640);
    expect(r).toMatchObject({ task_id: 'D1:00000001:0001:r2', state: 'UNASSIGNED', epoch: 3, owner: null, bid: null, renew: 0, created_at: 640, reorderOf: 'D1:00000001:0001' });
  });

  it('I2: every legal transition yields a strictly greater record; epochs never decrease (random walks)', () => {
    const rng = new Rng(0x0e0c4);
    const ids = ['A01', 'A02', 'A03', 'D1'];
    let steps = 0;
    for (let trial = 0; trial < 2000; trial++) {
      let r = rec();
      let granted: { owner: NodeId; epoch: number } | null = null;
      for (let k = 0; k < 40; k++) {
        const who = rng.pick(ids);
        const op = rng.int(0, 8);
        let next: TaskRecord | null = null;
        switch (op) {
          case 0: next = claimRecord(r, who, -rng.range(0, 100)); break;
          case 1: next = commitRecord(r, who, 0, 10, P); break;
          case 2: next = renewRecord(r, who); break;
          case 3: next = observerReopen(r, who, 0, 100, P); break;
          case 4: next = releaseRecord(r, who); break;
          case 5: {
            const d = depotPickup({ depotRecord: r, requester: who, epoch: r.epoch - rng.int(0, 1), granted });
            if (d.kind === 'PICKUP_GRANT' && !d.regrant) granted = { owner: who, epoch: r.epoch };
            next = d.record && compareTaskRecords(d.record, r) !== 0 ? d.record : null;
            break;
          }
          case 6: next = deliveredRecord(r, who); break;
          case 7: next = rng.chance(0.2) ? abortRecord(r) : null; break;
          case 8: next = r.state === 'UNASSIGNED' && rng.chance(0.3) ? reopenRecord({ ...r, state: 'CLAIMED', owner: who }) : null; break;
        }
        if (next) {
          expect(compareTaskRecords(next, r)).toBeGreaterThan(0);
          expect(next.epoch).toBeGreaterThanOrEqual(r.epoch);
          r = next;
          steps++;
        }
      }
    }
    expect(steps).toBeGreaterThan(5000);
  });
});

// ---- depot pickup ---------------------------------------------------------------------------------------------

describe('depot pickup arbitration (PRD 10 depot_pickup)', () => {
  const claimed = rec({ state: 'COMMITTED', epoch: 3, owner: 'A01', bid: -1 });

  it('grants the owner of the current epoch and writes PICKED_UP', () => {
    const d = depotPickup({ depot: 'D1', depotRecord: claimed, carried: claimed, requester: 'A01', epoch: 3 });
    expect(d.kind).toBe('PICKUP_GRANT');
    if (d.kind === 'PICKUP_GRANT') {
      expect(d.record.state).toBe('PICKED_UP');
      expect(d.record.owner).toBe('A01');
      expect(d.regrant).toBe(false);
    }
  });

  it('stale epoch: a zombie with an old epoch is refused', () => {
    const d = depotPickup({ depotRecord: claimed, carried: rec({ state: 'COMMITTED', epoch: 1, owner: 'A02' }), requester: 'A02', epoch: 1 });
    expect(d).toMatchObject({ kind: 'TASK_TAKEN', reason: 'stale_epoch' });
    if (d.kind === 'TASK_TAKEN') expect(d.record).toEqual(claimed);
  });

  it('wrong owner at the current epoch is refused', () => {
    expect(depotPickup({ depotRecord: claimed, requester: 'A02', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'not_owner' });
  });

  it('already picked up / delivered / aborted / re-opened are refused', () => {
    expect(depotPickup({ depotRecord: { ...claimed, state: 'PICKED_UP' }, requester: 'A02', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'already_picked_up' });
    expect(depotPickup({ depotRecord: { ...claimed, state: 'DELIVERED' }, requester: 'A01', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'terminal' });
    expect(depotPickup({ depotRecord: { ...claimed, state: 'ABORTED' }, requester: 'A01', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'terminal' });
    expect(depotPickup({ depotRecord: reopenRecord(claimed)!, requester: 'A01', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'not_claimed' });
  });

  it('a carried record newer than the depot record is merged first and can be granted', () => {
    const old = rec({ state: 'UNASSIGNED', epoch: 2 });
    const carried = claimRecord(old, 'A04', -3)!; // epoch 3, depot has not heard the claim yet
    const d = depotPickup({ depotRecord: old, carried, requester: 'A04', epoch: 3 });
    expect(d.kind).toBe('PICKUP_GRANT');
    expect(d.record).toMatchObject({ state: 'PICKED_UP', epoch: 3, owner: 'A04' });
    expect(compareTaskRecords(d.record!, old)).toBeGreaterThan(0);
  });

  it('a carried record newer than the depot record that shows a re-open refuses the stale claimant', () => {
    const reopened = reopenRecord(claimed)!; // epoch 4 open, the depot has only epoch 3
    const d = depotPickup({ depotRecord: claimed, carried: reopened, requester: 'A01', epoch: 3 });
    expect(d).toMatchObject({ kind: 'TASK_TAKEN', reason: 'not_claimed' });
    expect(d.record).toEqual(reopened);
  });

  it('resend after a lost grant is answered with the same grant (idempotent)', () => {
    const g = depotPickup({ depotRecord: claimed, requester: 'A01', epoch: 3 });
    const again = depotPickup({ depotRecord: g.record!, requester: 'A01', epoch: 3, granted: { owner: 'A01', epoch: 3 } });
    expect(again).toMatchObject({ kind: 'PICKUP_GRANT', regrant: true });
  });

  it('grant memory fences a stale re-open + new claim that out-ranks the PICKED_UP record', () => {
    const picked = { ...claimed, state: 'PICKED_UP' as const };
    const newClaim = claimRecord(reopenRecord(claimed)!, 'A02', -1)!; // epoch 5 by a replica that never saw the pickup
    const d = depotPickup({ depotRecord: picked, carried: newClaim, requester: 'A02', epoch: 5, granted: { owner: 'A01', epoch: 3 } });
    expect(d).toMatchObject({ kind: 'TASK_TAKEN', reason: 'already_picked_up' });
    expect(d.record).toMatchObject({ state: 'PICKED_UP', owner: 'A01', epoch: 5 });
    expect(compareTaskRecords(d.record!, newClaim)).toBeGreaterThan(0);
    expect(compareTaskRecords(d.record!, picked)).toBeGreaterThan(0);
  });

  it('unknown task and wrong depot', () => {
    expect(depotPickup({ depotRecord: undefined, requester: 'A01', epoch: 1 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'unknown_task' });
    expect(depotPickup({ depot: 'D2', depotRecord: claimed, requester: 'A01', epoch: 3 })).toMatchObject({ kind: 'TASK_TAKEN', reason: 'wrong_depot' });
  });

  it('at most one grant per task under random interleavings (I1 backstop)', () => {
    const rng = new Rng(77);
    for (let trial = 0; trial < 1000; trial++) {
      let depot = rec({ epoch: 0 });
      const drones = ['A01', 'A02', 'A03'];
      const views = new Map<string, TaskRecord>(drones.map((d) => [d, depot]));
      let granted: { owner: NodeId; epoch: number } | null = null;
      const grants = new Set<string>();
      for (let k = 0; k < 30; k++) {
        const d = rng.pick(drones);
        let v = views.get(d)!;
        if (rng.chance(0.3)) v = mergeTaskRecords(v, depot); // partial gossip
        const act = rng.int(0, 3);
        if (act === 0) v = claimRecord(v, d, -1) ?? v;
        else if (act === 1) v = observerReopen(v, d, 0, 100, P) ?? v;
        else if (act === 2 && v.owner === d) {
          const res = depotPickup({ depotRecord: depot, carried: v, requester: d, epoch: v.epoch, granted });
          if (res.kind === 'PICKUP_GRANT') {
            grants.add(d);
            if (!res.regrant) granted = { owner: d, epoch: v.epoch };
          }
          if (res.record) {
            expect(compareTaskRecords(res.record, depot)).toBeGreaterThanOrEqual(0);
            depot = res.record;
          }
        }
        views.set(d, v);
      }
      expect(grants.size).toBeLessThanOrEqual(1);
    }
  });
});

// ---- lease timing ---------------------------------------------------------------------------------------------

describe('lease timing', () => {
  it('owner lapses after lease_ttl, observer after lease_ttl * (1 + margin) + grace', () => {
    expect(ownerLeaseLapsed(100, 120, P)).toBe(false);
    expect(ownerLeaseLapsed(100, 120.01, P)).toBe(true);
    expect(observerLeaseExpired(100, 122.39, P)).toBe(false);
    expect(observerLeaseExpired(100, 122.41, P)).toBe(true);
    expect(observerLeaseExpired(0, 11, P, 5)).toBe(true); // record's own lease_s
  });

  it('OwnerLeaseTracker: renew cadence ttl/4, commit due, confirmations move the ack base, sticky after pickup', () => {
    const t = new OwnerLeaseTracker(P);
    const c = claimRecord(rec(), 'A01', -1)!;
    t.track(c, 1000);
    expect(t.commitDue(c.task_id, 1002.9)).toBe(false);
    expect(t.commitDue(c.task_id, 1003)).toBe(true);
    t.markCommitted(c.task_id);
    expect(t.commitDue(c.task_id, 1010)).toBe(false);
    expect(t.renewDue(c.task_id, 1004.9)).toBe(false);
    expect(t.renewDue(c.task_id, 1005)).toBe(true);
    t.renewed(c.task_id, 1, 1005);
    t.renewed(c.task_id, 2, 1010);
    expect(t.lapsed(c.task_id, 1020.5)).toBe(true); // nothing confirmed: base = claim
    t.confirm(c.task_id, c.epoch + 1, 2); // other epoch: ignored
    expect(t.lastAck(c.task_id)).toBe(1000);
    t.confirm(c.task_id, c.epoch, 1);
    expect(t.lastAck(c.task_id)).toBe(1005);
    t.confirm(c.task_id, c.epoch, 0); // older: ignored
    expect(t.lastAck(c.task_id)).toBe(1005);
    t.confirm(c.task_id, c.epoch, 9); // covers renew 2 (the newest written)
    expect(t.lastAck(c.task_id)).toBe(1010);
    expect(t.lapsed(c.task_id, 1030)).toBe(false);
    expect(t.expire(1030.01)).toEqual([c.task_id]);
    expect(t.has(c.task_id)).toBe(false);
    t.track(c, 2000);
    t.markPickedUp(c.task_id);
    expect(t.lapsed(c.task_id, 9999)).toBe(false);
    expect(t.renewDue(c.task_id, 9999)).toBe(false);
  });
});

// ---- I3 / AT-09 property: zombie-stop before re-open under drift, delay and loss -------------------------------

interface I3Opts {
  p: LeaseParams;
  driftMax: number;
  nObs: number;
  lossMax: number;
  delayMax: number;
  isolate: boolean;
}
interface I3Result {
  reopens: number;
  covered: number;
  stale: number;
  unsafe: number;
  minMarginS: number;
}

/**
 * One trial on simulation time with tick dt = 0.1 s. The owner claims at t = 0, renews every lease/4 on its clock,
 * observers ack what they see (acks are lossy and delayed too), the owner is isolated at a random time (tx and rx
 * cut). Each observer re-opens when its view expires. For every re-open we check the owner had zombie-stopped strictly
 * earlier. `stale` re-opens come from an observer that never saw the owner's last confirmed renewal (it was confirmed
 * by another observer): the asymmetry cannot cover those, depot fencing does.
 */
function runI3Trial(rng: Rng, o: I3Opts): I3Result {
  const dt = 0.1;
  const mkClock = () => {
    const off = rng.range(0, 5000);
    const d = rng.range(-o.driftMax, o.driftMax);
    return (t: number) => off + t * (1 + d);
  };
  const ownerClock = mkClock();
  const obs = Array.from({ length: o.nObs }, () => ({ clock: mkClock(), seen: -1, seenAt: 0, reopenAt: -1 }));
  const loss = rng.range(0, o.lossMax);
  const delayMax = rng.range(0, o.delayMax);
  const tIso = o.isolate ? rng.range(0, 60) : Infinity;
  type Msg = { at: number; seq: number; to: number; renew: number }; // to = -1: ack to owner
  const q: Msg[] = [];
  let seq = 0;
  const send = (tNow: number, to: number, renew: number) => {
    if (to >= 0 && tNow >= tIso) return; // owner tx cut
    if (rng.chance(loss)) return;
    const at = tNow + rng.range(0, delayMax);
    if (to < 0 && at >= tIso) return; // owner rx cut
    q.push({ at, seq: seq++, to, renew });
  };

  const tracker = new OwnerLeaseTracker(o.p);
  let r = claimRecord(rec(), 'OWN', -1, o.p.leaseTtlS)!;
  tracker.track(r, ownerClock(0));
  for (let i = 0; i < o.nObs; i++) send(0, i, 0);
  let ownerStop = -1;
  const res: I3Result = { reopens: 0, covered: 0, stale: 0, unsafe: 0, minMarginS: Infinity };
  const tEnd = (o.isolate ? tIso : 200) + 80;
  for (let k = 1; k * dt <= tEnd; k++) {
    const t = k * dt;
    // deliver in (at, seq) order
    q.sort((a, b) => a.at - b.at || a.seq - b.seq);
    while (q.length && q[0].at <= t) {
      const m = q.shift()!;
      if (m.to < 0) {
        if (ownerStop < 0) tracker.confirm(r.task_id, r.epoch, m.renew);
      } else {
        const x = obs[m.to];
        if (x.reopenAt >= 0) continue;
        if (m.renew > x.seen) {
          x.seen = m.renew;
          x.seenAt = x.clock(t);
        }
        send(t, -1, x.seen);
      }
    }
    if (ownerStop < 0) {
      const now = ownerClock(t);
      if (tracker.lapsed(r.task_id, now)) {
        ownerStop = t;
        tracker.expire(now);
      } else if (tracker.renewDue(r.task_id, now)) {
        r = renewRecord(r, 'OWN')!;
        tracker.renewed(r.task_id, r.renew, now);
        for (let i = 0; i < o.nObs; i++) send(t, i, r.renew);
      }
    }
    for (const x of obs) {
      if (x.reopenAt >= 0 || x.seen < 0) continue;
      if (!observerLeaseExpired(x.seenAt, x.clock(t), o.p)) continue;
      x.reopenAt = t;
      res.reopens++;
      if (ownerStop >= 0 && ownerStop < t) {
        res.covered++;
        res.minMarginS = Math.min(res.minMarginS, t - ownerStop);
      } else if (x.seen < (tracker.confirmedRenew(r.task_id) ?? -1)) res.stale++;
      else res.unsafe++;
    }
    if (ownerStop >= 0 && obs.every((x) => x.reopenAt >= 0 || x.seen < 0)) break;
  }
  return res;
}

function runI3(seed: number, trials: number, o: I3Opts) {
  const rng = new Rng(seed);
  const tot = { reopens: 0, covered: 0, stale: 0, unsafe: 0, minMarginS: Infinity, unsafeTrials: 0 };
  for (let i = 0; i < trials; i++) {
    const r = runI3Trial(rng, o);
    tot.reopens += r.reopens;
    tot.covered += r.covered;
    tot.stale += r.stale;
    tot.unsafe += r.unsafe;
    tot.minMarginS = Math.min(tot.minMarginS, r.minMarginS);
    if (r.unsafe) tot.unsafeTrials++;
  }
  return tot;
}

describe('I3 / AT-09: owner zombie-stop strictly precedes any re-open (property, seeded)', () => {
  const NAIVE: LeaseParams = { ...P, driftMargin: 0, graceS: 0 };

  it('one authority observer (the origin depot), drift in [-1 %, +1 %], loss and delay: always safe', () => {
    const t = runI3(0xa709, 2000, { p: P, driftMax: 0.01, nObs: 1, lossMax: 0.4, delayMax: 3, isolate: true });
    expect(t.unsafe).toBe(0);
    expect(t.stale).toBe(0);
    expect(t.covered).toBe(t.reopens);
    expect(t.reopens).toBeGreaterThan(1900);
    expect(t.minMarginS).toBeGreaterThan(0);
  });

  it('drift up to 2 % (inside the drift margin): always safe', () => {
    const t = runI3(0xa710, 2000, { p: P, driftMax: 0.02, nObs: 1, lossMax: 0.4, delayMax: 3, isolate: true });
    expect(t.unsafe).toBe(0);
    expect(t.covered).toBe(t.reopens);
  });

  it('several observers: every observer that saw the owner\'s last confirmed renewal re-opens after the stop', () => {
    const t = runI3(0xa711, 1000, { p: P, driftMax: 0.01, nObs: 4, lossMax: 0.3, delayMax: 2, isolate: true });
    expect(t.unsafe).toBe(0);
    expect(t.covered).toBeGreaterThan(3000);
    // stale observers exist under loss: the timing alone cannot protect them, depot fencing does (see depot tests)
    expect(t.covered + t.stale).toBe(t.reopens);
  });

  it('the margin + grace asymmetry is load-bearing: the naive symmetric rule breaks I3', () => {
    const t = runI3(0xa712, 2000, { p: NAIVE, driftMax: 0.01, nObs: 1, lossMax: 0, delayMax: 0.2, isolate: true });
    expect(t.unsafeTrials).toBeGreaterThan(50);
  });
});

// ---- partition policies -----------------------------------------------------------------------------------------

function view(o: {
  me?: NodeId;
  reachable: NodeId[];
  known: NodeId[];
  shard?: { lease: ShardLeaseRecord; live: boolean } | null;
  optimistic?: number;
}): FleetView {
  return {
    me: o.me ?? 'A01',
    nowLocal: () => 0,
    reachable: () => [...o.reachable].sort(),
    knownFleet: () => [...o.known].sort(),
    shardLease: () => o.shard ?? null,
    optimisticClaims: () => o.optimistic ?? 0,
  };
}
const fleet = (n: number) => Array.from({ length: n }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);
const lease = (holder: NodeId | null): ShardLeaseRecord => ({ shard: 'H-1', depot: 'D1', epoch: 1, holder, renew: 0, lease_s: 30 });

describe('partition policies (03 3.5f)', () => {
  it('QUORUM: strict majority of the known fleet, odd and even sizes', () => {
    const q = createPartitionPolicy('QUORUM');
    const t = rec();
    const cases: [number, number, boolean][] = [
      [1, 1, true],
      [2, 1, false],
      [2, 2, true],
      [3, 1, false],
      [3, 2, true],
      [4, 2, false], // even split: neither half claims
      [4, 3, true],
      [5, 2, false],
      [5, 3, true],
      [6, 3, false],
      [6, 4, true],
    ];
    for (const [n, r, want] of cases) {
      const f = fleet(n);
      expect(q.mayClaimNew(t, view({ reachable: f.slice(0, r), known: f })), `${r}/${n}`).toBe(want);
    }
    // reachable nodes outside the known fleet (declared failed) do not count
    expect(q.mayClaimNew(t, view({ reachable: ['A01', 'A07', 'A08'], known: fleet(4) }))).toBe(false);
    expect(q.mayClaimNew(t, view({ reachable: [], known: [] }))).toBe(false);
  });

  it('STRICT: only with a live shard lease held by a reachable drone', () => {
    const s = createPartitionPolicy('STRICT');
    const t = rec();
    const f = fleet(5);
    const r = ['A01', 'A02'];
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: { lease: lease('A02'), live: true } }))).toBe(true);
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: { lease: lease('A01'), live: true } }))).toBe(true);
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: { lease: lease('A02'), live: false } }))).toBe(false); // expired
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: { lease: lease('A04'), live: true } }))).toBe(false); // foreign
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: { lease: lease(null), live: true } }))).toBe(false); // handed back
    expect(s.mayClaimNew(t, view({ reachable: r, known: f, shard: null }))).toBe(false);
    // STRICT ignores quorum: a full fleet without a lease still waits
    expect(s.mayClaimNew(t, view({ reachable: f, known: f, shard: null }))).toBe(false);
  });

  it('OPTIMISTIC_BOUNDED: quorum, or priority >= 2 below MAX_OPTIMISTIC; priority 1 never optimistic', () => {
    const o = createPartitionPolicy('OPTIMISTIC_BOUNDED');
    const f = fleet(5);
    const minority = { reachable: ['A01', 'A02'], known: f };
    const majority = { reachable: ['A01', 'A02', 'A03'], known: f };
    for (const pr of [1, 2, 3] as const) {
      expect(o.mayClaimNew(rec({ priority: pr }), view({ ...majority, optimistic: 5 }))).toBe(true);
    }
    expect(o.mayClaimNew(rec({ priority: 1 }), view({ ...minority, optimistic: 0 }))).toBe(false);
    expect(o.mayClaimNew(rec({ priority: 2 }), view({ ...minority, optimistic: 0 }))).toBe(true);
    expect(o.mayClaimNew(rec({ priority: 3 }), view({ ...minority, optimistic: 0 }))).toBe(true);
    expect(o.mayClaimNew(rec({ priority: 2 }), view({ ...minority, optimistic: 1 }))).toBe(false);
    const o3 = createPartitionPolicy('OPTIMISTIC_BOUNDED', { maxOptimistic: 3 });
    expect(o3.mayClaimNew(rec({ priority: 3 }), view({ ...minority, optimistic: 2 }))).toBe(true);
    expect(o3.mayClaimNew(rec({ priority: 3 }), view({ ...minority, optimistic: 3 }))).toBe(false);
  });

  it('claimDecision flags optimistic claims only for OPTIMISTIC_BOUNDED without quorum', () => {
    const f = fleet(4);
    const minority = view({ reachable: ['A01'], known: f });
    const majority = view({ reachable: ['A01', 'A02', 'A03'], known: f });
    expect(claimDecision(createPartitionPolicy('OPTIMISTIC_BOUNDED'), rec(), minority)).toEqual({ allowed: true, optimistic: true });
    expect(claimDecision(createPartitionPolicy('OPTIMISTIC_BOUNDED'), rec(), majority)).toEqual({ allowed: true, optimistic: false });
    expect(claimDecision(createPartitionPolicy('QUORUM'), rec(), minority)).toEqual({ allowed: false, optimistic: false });
    expect(quorumHolds(majority)).toBe(true);
    expect(createPartitionPolicy('STRICT').name).toBe('STRICT');
  });
});

// ---- shard leases -----------------------------------------------------------------------------------------------

describe('shard leases (REQ-OWN-005)', () => {
  const SP = DEFAULT_SHARD_LEASE_PARAMS;
  const req = (requester: NodeId) => ({ shard: 'H-1', depot: 'D1', requester });

  it('depot: grant when free, renew for the live holder, refuse others, re-grant epoch + 1 once expired', () => {
    const g = depotShardLeaseDecision(null, null, req('A01'), 100, SP);
    expect(g).toMatchObject({ kind: 'granted', lease: { epoch: 1, holder: 'A01', renew: 0, lease_s: 30 } });
    const l = g.lease!;
    expect(depotShardLeaseDecision(l, 100, req('A01'), 110, SP)).toMatchObject({ kind: 'renewed', lease: { epoch: 1, renew: 1 } });
    expect(depotShardLeaseDecision(l, 100, req('A02'), 110, SP)).toMatchObject({ kind: 'refused', reason: 'held_by_other' });
    const bound = 30 * 1.02 + 2;
    expect(depotShardLeaseLive(l, 100, 100 + bound, SP)).toBe(true);
    expect(depotShardLeaseDecision(l, 100, req('A02'), 100 + bound + 0.01, SP)).toMatchObject({ kind: 'granted', lease: { epoch: 2, holder: 'A02' } });
  });

  it('hand-back (delegation): holder only; the depot then grants the next requester', () => {
    const l = depotShardLeaseDecision(null, null, req('A01'), 0, SP).lease!;
    expect(handBackShardLease(l, 'A02')).toBeNull();
    const hb = handBackShardLease(l, 'A01')!;
    expect(hb).toMatchObject({ holder: null, renew: 1, epoch: 1 });
    expect(depotAcceptHandBack(l, hb, 'A02')).toBeNull();
    const cur = depotAcceptHandBack(l, hb, 'A01')!;
    expect(depotShardLeaseDecision(cur, 0, req('A02'), 1, SP)).toMatchObject({ kind: 'granted', lease: { epoch: 2, holder: 'A02' } });
  });

  it('holder: holds while the last acked request is younger than lease_s; renew every lease_s / 3', () => {
    const h = new ShardLeaseHolder('A01');
    h.requested('H-1', 50);
    const l = depotShardLeaseDecision(null, null, req('A01'), 9999, SP).lease!;
    h.onAnswer(l, 50);
    expect(h.holds('H-1', 80)).toBe(true);
    expect(h.holds('H-1', 80.01)).toBe(false);
    expect(holderShardLeaseLapsed(50, 80.01, 30)).toBe(true);
    expect(h.renewDue('H-1', 59.9)).toBe(false);
    expect(h.renewDue('H-1', 60)).toBe(true);
    h.onAnswer({ ...l, renew: 1 }, 60);
    expect(h.holds('H-1', 89)).toBe(true);
    h.onAnswer({ ...l, epoch: 2, holder: 'A02' }, 61); // someone else's newer lease
    expect(h.holds('H-1', 62)).toBe(false);
    expect(h.heldShards(62)).toEqual([]);
  });

  /**
   * Property: a depot and three drones with drifting clocks, lossy delayed links and random partitions between
   * drones and the depot; drones request when they hold nothing, renew every lease/3, sometimes hand back. At no
   * simulation tick do two drones both believe they hold the shard lease.
   */
  function runShardTrial(rng: Rng, p: ShardLeaseParams, driftMax: number, delayCap = 3) {
    const dt = 0.1;
    const T = 400;
    const mkClock = () => {
      const off = rng.range(0, 5000);
      const d = rng.range(-driftMax, driftMax);
      return (t: number) => off + t * (1 + d);
    };
    const depotClock = mkClock();
    const ids = ['A01', 'A02', 'A03'];
    const drones = ids.map((id) => ({ id, clock: mkClock(), holder: new ShardLeaseHolder(id), cuts: [] as [number, number][], lastReq: -Infinity }));
    for (const d of drones) for (let i = 0; i < 3; i++) {
      const s = rng.range(0, T);
      d.cuts.push([s, s + rng.range(5, 90)]);
    }
    const loss = rng.range(0, 0.3);
    const delayMax = rng.range(0, delayCap);
    const cut = (d: (typeof drones)[number], t: number) => d.cuts.some(([a, b]) => t >= a && t < b);
    type Msg = { at: number; seq: number; kind: 'req' | 'ans' | 'hb'; drone: number; sent: number; lease?: ShardLeaseRecord };
    const q: Msg[] = [];
    let seq = 0;
    const send = (t: number, m: Omit<Msg, 'at' | 'seq'>) => {
      const d = drones[m.drone];
      if (cut(d, t) || rng.chance(loss)) return;
      const at = t + rng.range(0, delayMax);
      if (cut(d, at)) return;
      q.push({ ...m, at, seq: seq++ });
    };
    let cur: ShardLeaseRecord | null = null;
    let lastGrant: number | null = null;
    let maxEpoch = 0;
    let overlaps = 0;
    const holders = new Set<string>();
    for (let k = 1; k * dt <= T; k++) {
      const t = k * dt;
      q.sort((a, b) => a.at - b.at || a.seq - b.seq);
      while (q.length && q[0].at <= t) {
        const m = q.shift()!;
        const d = drones[m.drone];
        if (m.kind === 'req') {
          const now = depotClock(t);
          const dec = depotShardLeaseDecision(cur, lastGrant, { shard: 'H-1', depot: 'D1', requester: d.id }, now, p);
          if (dec.kind !== 'refused') {
            cur = dec.lease;
            lastGrant = now;
            expect(cur.epoch).toBeGreaterThanOrEqual(maxEpoch);
            maxEpoch = cur.epoch;
          }
          if (dec.lease) send(t, { kind: 'ans', drone: m.drone, sent: m.sent, lease: dec.lease });
        } else if (m.kind === 'ans') {
          d.holder.onAnswer(m.lease!, m.sent);
        } else {
          const acc = depotAcceptHandBack(cur, m.lease!, d.id);
          if (acc) cur = acc;
        }
      }
      let believers = 0;
      for (let i = 0; i < drones.length; i++) {
        const d = drones[i];
        const now = d.clock(t);
        if (d.holder.holds('H-1', now)) {
          believers++;
          holders.add(d.id);
          if (rng.chance(0.002)) {
            const hb = d.holder.handBack('H-1');
            if (hb) send(t, { kind: 'hb', drone: i, sent: now, lease: hb });
          } else if (d.holder.renewDue('H-1', now)) {
            d.holder.requested('H-1', now);
            send(t, { kind: 'req', drone: i, sent: now });
          }
        } else if (now - d.lastReq >= 2 && rng.chance(0.05)) {
          d.lastReq = now;
          d.holder.requested('H-1', now);
          send(t, { kind: 'req', drone: i, sent: now });
        }
      }
      // count after this tick's hand-backs: a hand-back ends the belief immediately
      let after = 0;
      for (const d of drones) if (d.holder.holds('H-1', d.clock(t))) after++;
      if (Math.min(believers, after) > 1) overlaps++;
    }
    return { overlaps, holders: holders.size, epochs: maxEpoch };
  }

  it('property: two sides of a partition never both hold the same shard lease (drift up to 2 %)', () => {
    const rng = new Rng(0x5a4d);
    let overlaps = 0;
    let handovers = 0;
    let epochs = 0;
    const trials = 600;
    for (let i = 0; i < trials; i++) {
      const r = runShardTrial(rng, SP, 0.02, i % 2 ? 0.2 : 3); // half with the short delays that break the naive rule
      overlaps += r.overlaps;
      if (r.holders > 1) handovers++;
      epochs += r.epochs;
    }
    expect(overlaps).toBe(0);
    expect(handovers).toBeGreaterThan(trials / 2); // non-vacuous: the lease really moved between drones
    expect(epochs).toBeGreaterThan(trials * 2);
  });

  it('without margin + grace at the depot, overlaps appear (the asymmetry is load-bearing here too)', () => {
    const rng = new Rng(0x5a4e);
    let bad = 0;
    for (let i = 0; i < 300; i++) if (runShardTrial(rng, { ...SP, driftMargin: 0, graceS: 0 }, 0.02, 0.2).overlaps > 0) bad++;
    expect(bad).toBeGreaterThan(0);
  });
});

// ---- post-merge duplicate resolution --------------------------------------------------------------------------------

describe('post-merge duplicate resolution (03 3.5g, REQ-OWN-006)', () => {
  const mine = rec({ state: 'COMMITTED', epoch: 3, owner: 'A02', bid: -5 });

  it('keeps when the merge confirms me (incl. my renewals and the depot grant)', () => {
    expect(resolveAfterMerge(mine, { ...mine, renew: 4 }, 'A02')).toEqual({ action: 'keep', reassert: null });
    expect(resolveAfterMerge(mine, { ...mine, state: 'PICKED_UP' }, 'A02')).toEqual({ action: 'keep', reassert: null });
  });

  it('pre-pickup duplicate: the merge loser drops with a duplicate_resolved event', () => {
    const r = resolveAfterMerge(mine, { ...mine, owner: 'A01' }, 'A02');
    expect(r).toMatchObject({ action: 'drop', stage: 'pre_pickup', event: { reason: 'outbid', duplicate: true, winner: 'A01', stage: 'pre_pickup', node: 'A02' } });
    expect(resolveAfterMerge(mine, { ...mine, epoch: 5, owner: 'A09' }, 'A02')).toMatchObject({ action: 'drop', event: { reason: 'superseded', duplicate: true } });
    expect(resolveAfterMerge(mine, reopenRecord(mine)!, 'A02')).toMatchObject({ action: 'drop', event: { reason: 'reopened', duplicate: false } });
    expect(resolveAfterMerge(mine, { ...mine, state: 'PICKED_UP', owner: 'A01' }, 'A02')).toMatchObject({ action: 'drop', event: { reason: 'taken' } });
  });

  it('post-pickup duplicate: the holder that lost the merge diverts', () => {
    const carrying = { ...mine, state: 'PICKED_UP' as const };
    const other = { ...mine, state: 'PICKED_UP' as const, owner: 'A01' };
    expect(resolveAfterMerge(carrying, other, 'A02')).toMatchObject({ action: 'divert', stage: 'post_pickup', event: { reason: 'taken', duplicate: true, winner: 'A01' } });
    expect(resolveAfterMerge(other, other, 'A01')).toEqual({ action: 'keep', reassert: null });
    expect(resolveAfterMerge(carrying, abortRecord(carrying)!, 'A02')).toMatchObject({ action: 'divert', event: { reason: 'aborted', duplicate: false } });
  });

  it('post-pickup: a stale re-open that out-ranks my pickup is answered with a re-assertion, not a divert', () => {
    const carrying = { ...mine, state: 'PICKED_UP' as const };
    const stale = claimRecord(reopenRecord(mine)!, 'A05', -1)!; // epoch 5, never saw the pickup
    const r = resolveAfterMerge(carrying, mergeTaskRecords(carrying, stale), 'A02');
    expect(r.action).toBe('keep');
    if (r.action === 'keep') {
      expect(r.reassert).toMatchObject({ state: 'PICKED_UP', owner: 'A02', epoch: 5 });
      expect(compareTaskRecords(r.reassert!, stale)).toBeGreaterThan(0);
    }
  });

  it('nothing held: keep', () => {
    expect(resolveAfterMerge(rec(), rec({ epoch: 2 }), 'A02')).toEqual({ action: 'keep', reassert: null });
  });
});
