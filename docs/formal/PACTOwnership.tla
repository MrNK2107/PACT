--------------------------- MODULE PACTOwnership ---------------------------
(***************************************************************************)
(* Fenced ownership of one parcel in PACT, model-checked with TLC.         *)
(*                                                                         *)
(* Mirrors sim3d/src/p2p/ownership.ts and sim3d/src/p2p/DepotNode.ts:      *)
(*  - claimRecord: UNASSIGNED -> CLAIMED, epoch + 1, per-claim lease_s     *)
(*    (any value in Leases: this covers adaptive "planned silence" leases) *)
(*  - renewRecord / depot ack: the owner counts a renewal only once the    *)
(*    depot confirmed it; lastAck = owner-local WRITE time of that renewal *)
(*  - ownerLeaseLapsed (zombie-stop, I3): owner stops when                 *)
(*        clk[owner] - lastAck > lease                                     *)
(*  - observerLeaseExpired at the depot: re-open only when                 *)
(*        clk[depot] - seenAt > lease + Margin                             *)
(*    (Margin is the integer form of lease*driftMargin + grace)            *)
(*  - depotPickup: grant only the owner of the current epoch; grant memory *)
(*                                                                         *)
(* Environment: messages may be lost, duplicated and reordered (the        *)
(* network is a set that is never forced to deliver: this also covers any  *)
(* partition); drones may crash; clocks drift within a bounded budget.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Drones,        \* e.g. {d1, d2, d3}
    Leases,        \* allowed per-claim lease lengths in ticks, e.g. {2, 4}
    Margin,        \* depot-side safety margin in ticks (drift + grace)
    DriftBudget,   \* how many extra ticks any one clock may gain over the run
    MaxTime,       \* bound on real time (model size)
    MaxEpoch,      \* bound on epochs (model size)
    FenceDepot     \* TRUE = real protocol; FALSE = mutant without epoch fencing

Depot == "depot"
Nodes == Drones \cup {Depot}
NoOwner == "none"

VARIABLES
    now,        \* real time (for bounding only; no node reads it)
    clk,        \* local clocks
    skew,       \* extra ticks each clock has gained so far (drift)
    rec,        \* depot record: [st, epoch, owner, lease, seenAt]
    owns,       \* drone -> epoch it believes it owns (0 = none)
    lease,      \* drone -> lease length of its current claim
    lastAck,    \* drone -> owner-local write time of its last CONFIRMED renewal
    alive,      \* drone -> not crashed
    net,        \* set of messages in flight (may be lost / duplicated / reordered)
    granted,    \* history: drones the depot handed the parcel to
    badReopen,  \* history: depot re-opened while the owner still held a live lease
    seen        \* drone -> highest epoch in its own replica (replica epochs only grow)

vars == <<now, clk, skew, rec, owns, lease, lastAck, alive, net, granted, badReopen, seen>>

Lapsed(d) == clk[d] - lastAck[d] > lease[d]

Init ==
    /\ now = 0
    /\ clk = [n \in Nodes |-> 0]
    /\ skew = [n \in Nodes |-> 0]
    /\ rec = [st |-> "UNASSIGNED", epoch |-> 0, owner |-> NoOwner, lease |-> 0, seenAt |-> 0]
    /\ owns = [d \in Drones |-> 0]
    /\ lease = [d \in Drones |-> 0]
    /\ lastAck = [d \in Drones |-> 0]
    /\ alive = [d \in Drones |-> TRUE]
    /\ net = {}
    /\ granted = {}
    /\ badReopen = FALSE
    /\ seen = [d \in Drones |-> 0]

(* --- time -------------------------------------------------------------- *)
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ clk' = [n \in Nodes |-> clk[n] + 1]
    /\ UNCHANGED <<skew, rec, owns, lease, lastAck, alive, net, granted, badReopen, seen>>

\* Drift: one clock runs fast by one tick (a slow clock is the others running fast).
Drift(n) ==
    /\ skew[n] < DriftBudget
    /\ clk' = [clk EXCEPT ![n] = @ + 1]
    /\ skew' = [skew EXCEPT ![n] = @ + 1]
    /\ UNCHANGED <<now, rec, owns, lease, lastAck, alive, net, granted, badReopen, seen>>

(* --- drones ------------------------------------------------------------ *)
\* claimRecord: a drone that learned epoch e is open claims e + 1 optimistically.
\* It believes it owns the parcel immediately (the dangerous case), before any merge.
Claim(d, e, L) ==
    /\ alive[d] /\ owns[d] = 0
    /\ e < MaxEpoch
    /\ e >= rec.epoch - 1          \* stale knowledge allowed (bounded for model size)
    /\ e >= seen[d]                \* ...but never older than the drone's own replica
    /\ seen' = [seen EXCEPT ![d] = e + 1]
    /\ L \in Leases
    /\ owns' = [owns EXCEPT ![d] = e + 1]
    /\ lease' = [lease EXCEPT ![d] = L]
    /\ lastAck' = [lastAck EXCEPT ![d] = clk[d]]   \* claim write time; counts once confirmed below
    /\ net' = net \cup {[type |-> "claim", from |-> d, epoch |-> e + 1, lease |-> L, w |-> clk[d]]}
    /\ UNCHANGED <<now, clk, skew, rec, alive, granted, badReopen>>

\* renewRecord: written at owner-local time w; it only counts when the depot confirms it.
Renew(d) ==
    /\ alive[d] /\ owns[d] > 0 /\ ~Lapsed(d)
    /\ net' = net \cup {[type |-> "renew", from |-> d, epoch |-> owns[d], lease |-> lease[d], w |-> clk[d]]}
    /\ UNCHANGED <<now, clk, skew, rec, owns, lease, lastAck, alive, granted, badReopen, seen>>

\* Confirmation: lastAck becomes the WRITE time of the confirmed renewal (never later).
RecvAck(d, m) ==
    /\ m \in net /\ m.type = "ack" /\ m.to = d
    /\ alive[d] /\ owns[d] = m.epoch
    /\ lastAck' = [lastAck EXCEPT ![d] = IF m.w > @ THEN m.w ELSE @]
    /\ UNCHANGED <<now, clk, skew, rec, owns, lease, alive, net, granted, badReopen, seen>>

\* ownerLeaseLapsed -> zombie-stop (I3): the owner stops on its own clock.
ZombieStop(d) ==
    /\ owns[d] > 0 /\ Lapsed(d)
    /\ owns' = [owns EXCEPT ![d] = 0]
    /\ UNCHANGED <<now, clk, skew, rec, lease, lastAck, alive, net, granted, badReopen, seen>>

\* A drone that learns it lost the parcel (refusal or a higher epoch) gives it up.
RecvLost(d, m) ==
    /\ m \in net /\ m.type = "lost" /\ m.to = d /\ owns[d] = m.epoch
    /\ owns' = [owns EXCEPT ![d] = 0]
    /\ seen' = [seen EXCEPT ![d] = IF m.epoch + 1 > @ THEN m.epoch + 1 ELSE @]
    /\ UNCHANGED <<now, clk, skew, rec, lease, lastAck, alive, net, granted, badReopen>>

\* The owner asks for the parcel only while its own lease is live.
RequestPickup(d) ==
    /\ alive[d] /\ owns[d] > 0 /\ ~Lapsed(d)
    /\ net' = net \cup {[type |-> "pickup", from |-> d, epoch |-> owns[d]]}
    /\ UNCHANGED <<now, clk, skew, rec, owns, lease, lastAck, alive, granted, badReopen, seen>>

Crash(d) ==
    /\ alive[d]
    /\ alive' = [alive EXCEPT ![d] = FALSE]
    /\ owns' = [owns EXCEPT ![d] = 0]
    /\ UNCHANGED <<now, clk, skew, rec, lease, lastAck, net, granted, badReopen, seen>>

(* --- depot ------------------------------------------------------------- *)
\* Merge of a claim: legal only on the open record at the next epoch (merge order
\* resolves concurrent claims; the loser hears it lost).
DepotClaim(m) ==
    /\ m \in net /\ m.type = "claim"
    /\ IF rec.st = "UNASSIGNED" /\ m.epoch = rec.epoch + 1
       THEN /\ rec' = [st |-> "CLAIMED", epoch |-> m.epoch, owner |-> m.from, lease |-> m.lease, seenAt |-> clk[Depot]]
            /\ net' = net \cup {[type |-> "ack", to |-> m.from, epoch |-> m.epoch, w |-> m.w]}
       ELSE /\ rec' = rec
            /\ net' = IF ~(rec.owner = m.from /\ rec.epoch = m.epoch)
                      THEN net \cup {[type |-> "lost", to |-> m.from, epoch |-> m.epoch]}
                      ELSE net
    /\ UNCHANGED <<now, clk, skew, owns, lease, lastAck, alive, granted, badReopen, seen>>

\* A renewal of the current claim refreshes seenAt and is acknowledged.
DepotRenew(m) ==
    /\ m \in net /\ m.type = "renew"
    /\ rec.st = "CLAIMED" /\ rec.owner = m.from /\ rec.epoch = m.epoch
    /\ rec' = [rec EXCEPT !.seenAt = clk[Depot], !.lease = m.lease]
    /\ net' = net \cup {[type |-> "ack", to |-> m.from, epoch |-> m.epoch, w |-> m.w]}
    /\ UNCHANGED <<now, clk, skew, owns, lease, lastAck, alive, granted, badReopen, seen>>

\* observerLeaseExpired -> reopen at epoch + 1. History check: was the owner still live?
DepotReopen ==
    /\ rec.st = "CLAIMED"
    /\ clk[Depot] - rec.seenAt > rec.lease + Margin
    /\ rec.epoch < MaxEpoch
    /\ LET o == rec.owner IN
         badReopen' = (badReopen \/ (alive[o] /\ owns[o] = rec.epoch /\ ~Lapsed(o)))
    /\ rec' = [st |-> "UNASSIGNED", epoch |-> rec.epoch + 1, owner |-> NoOwner, lease |-> 0, seenAt |-> clk[Depot]]
    /\ net' = net \cup {[type |-> "lost", to |-> rec.owner, epoch |-> rec.epoch]}
    /\ UNCHANGED <<now, clk, skew, owns, lease, lastAck, alive, granted, seen>>

\* depotPickup: grant only the owner of the current epoch (FenceDepot); grant memory.
DepotPickup(m) ==
    /\ m \in net /\ m.type = "pickup"
    /\ IF FenceDepot
       THEN /\ rec.st = "CLAIMED" /\ rec.owner = m.from /\ rec.epoch = m.epoch
            /\ rec' = [rec EXCEPT !.st = "PICKED", !.owner = m.from]
       ELSE \* mutant = the unfenced plain auction: no epoch/owner check, no grant memory
            /\ rec' = rec
    /\ granted' = granted \cup {m.from}
    /\ UNCHANGED <<now, clk, skew, owns, lease, lastAck, alive, net, badReopen, seen>>

\* Lossy network: any message may vanish at any time (covers partitions).
Lose(m) ==
    /\ m \in net
    /\ net' = net \ {m}
    /\ UNCHANGED <<now, clk, skew, rec, owns, lease, lastAck, alive, granted, badReopen, seen>>

Next ==
    \/ Tick
    \/ \E n \in Nodes : Drift(n)
    \/ \E d \in Drones, e \in 0..MaxEpoch, L \in Leases : Claim(d, e, L)
    \/ \E d \in Drones : Renew(d) \/ ZombieStop(d) \/ RequestPickup(d) \/ Crash(d)
    \/ \E d \in Drones, m \in net : RecvAck(d, m) \/ RecvLost(d, m)
    \/ \E m \in net : DepotClaim(m) \/ DepotRenew(m) \/ DepotPickup(m) \/ Lose(m)
    \/ DepotReopen

Spec == Init /\ [][Next]_vars

(* --- properties -------------------------------------------------------- *)
TypeOK ==
    /\ rec.st \in {"UNASSIGNED", "CLAIMED", "PICKED"}
    /\ rec.epoch \in 0..MaxEpoch
    /\ owns \in [Drones -> 0..MaxEpoch]
    /\ granted \subseteq Drones

\* I1: the depot hands the parcel to at most one drone, ever.
NoDoublePickup == Cardinality(granted) <= 1

\* I3: the depot never re-opens (and so never re-assigns) a parcel whose owner still
\* holds a live lease: the old owner has always zombie-stopped first.
NoReopenUnderLiveOwner == ~badReopen

\* Epochs only grow at the depot.
EpochMonotonic == [][rec'.epoch >= rec.epoch]_vars
=============================================================================
