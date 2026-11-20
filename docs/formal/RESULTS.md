# TLC results: PACT fenced ownership (20 Nov 2026)

Model: `PACTOwnership.tla`, TLC 1.7.4, Java 21. Two drones, one depot, one parcel; lossy / duplicating /
reordering network (covers any partition); drone crashes; bounded clock drift (DriftBudget 1 tick); per-claim
lease in {2, 4} ticks (covers adaptive "planned silence" leases); MaxTime 6, MaxEpoch 3.

| Configuration | Result | States |
|---|---|---|
| `MC.cfg`, real protocol (epoch fencing at the depot, depot margin 2 ticks ≥ drift) | **No violation** of TypeOK, NoDoublePickup (I1), NoReopenUnderLiveOwner (I3) in the states explored; stopped by us before exhausting the queue | 976,011,155 generated, 201,334,513 distinct, 126,690,733 left on queue, depth ≥ 17 |
| `MC_mutant_nofence.cfg`: depot hands the parcel to whoever asks (the unfenced plain auction) | **NoDoublePickup violated** (counterexample found) | 1,168,398 generated, depth 9 |
| `MC_mutant_nomargin.cfg`: depot ignores clock drift (margin 0) | **NoReopenUnderLiveOwner violated** (counterexample found) | 1,253,406 generated, depth 9 |

An earlier run with three drones (MaxTime 7) explored 165,709,440 distinct states without a violation before we
stopped it for memory.

An earlier version of the model let a drone re-claim an epoch it had already owned from stale knowledge, which the
code cannot do (a drone claims only an UNASSIGNED record in its own replica, and replica epochs only grow). TLC
flagged it at depth 13; the model now carries each drone's monotonic replica epoch (`seen`).

What this does and does not show: within these bounds no interleaving of loss, partitions, crashes, drift and
lease lengths breaks I1 or I3, and removing either safeguard breaks them quickly, so the checker is not vacuous.
It is a bounded, partially explored model of one parcel, abstracted from the TypeScript code, not a proof of the
implementation.
