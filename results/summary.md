# PACT benchmark summary

100 runs: 4 scenario(s) x 5 system(s) x 5 seed(s), 900 s of simulated time each.
Metrics come from the event log only. Values are means with a 95 % bootstrap CI in brackets. Simulation only: no claim of real-world flight readiness.

**On-time rate** = tasks that fell due inside the window and were delivered by their deadline, divided by the tasks that fell due.

## s0_healthy

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 86.3 [81.1, 93.1] | 20.0 [18.8, 21.2] | 0.0 | 0.5 [0.0, 1.6] | 0 | 0 | 0 | 76.0 [75.3, 76.9] | 142.8 [142.5, 143.2] | 0.1 |
| `central_full` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 0.0 | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `central_hub_loss` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 0.0 | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `greedy_nearest` | 80.6 [73.1, 90.3] | 21.2 [20.0, 22.2] | 0.0 | 0.7 [0.0, 2.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `cbba_plain` | 83.4 [76.0, 92.0] | 19.6 [18.2, 21.0] | 0.0 | 1.8 [0.0, 4.2] | 4 | 0 | 0 | 0.3 [0.3, 0.4] | 0.0 | 0.1 |

## s1_hub_loss

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 86.3 [81.1, 93.1] | 20.0 [18.8, 21.2] | 16.8 [16.2, 17.4] | 0.5 [0.0, 1.6] | 0 | 0 | 0 | 76.0 [75.3, 76.9] | 142.8 [142.5, 143.2] | 0.1 |
| `central_full` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 16.6 [16.0, 17.4] | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 56.8 [53.4, 59.4] | 7.6 [7.0, 8.4] | 4.0 [3.4, 4.6] | 0.0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 80.6 [73.1, 90.3] | 21.2 [20.0, 22.2] | 18.0 [16.4, 19.4] | 0.7 [0.0, 2.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `cbba_plain` | 83.4 [76.0, 92.0] | 19.6 [18.2, 21.0] | 16.2 [15.2, 17.2] | 1.8 [0.0, 4.2] | 4 | 0 | 0 | 0.3 [0.3, 0.4] | 0.0 | 0.1 |

## s6_battery_crunch

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 55.0 [48.7, 61.1] | 12.2 [12.0, 12.6] | 11.0 [10.4, 11.6] | 2.8 [0.1, 6.0] | 0 | 0 | 0 | 73.7 [72.6, 75.4] | 142.4 [142.3, 142.6] | 0.1 |
| `central_full` | 56.8 [52.3, 62.3] | 11.6 [11.2, 12.0] | 10.4 [9.6, 11.0] | 2.3 [0.0, 6.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 56.8 [52.3, 62.3] | 11.6 [11.2, 12.0] | 10.4 [9.6, 11.0] | 2.3 [0.0, 6.1] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 35.0 [23.9, 46.9] | 14.2 [13.6, 14.8] | 12.8 [11.8, 13.6] | 0.0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `cbba_plain` | 55.0 [48.7, 61.1] | 11.2 [10.0, 12.0] | 9.8 [8.4, 10.8] | 0.3 [0.0, 1.0] | 2 | 0 | 0 | 0.3 | 0.0 | 0.0 |

## s7_urgent_burst

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 75.0 [60.0, 90.0] | 18.6 [16.6, 20.6] | 6.8 [5.4, 7.8] | 0.1 [0.0, 0.2] | 0 | 0 | 0 | 76.2 [74.9, 77.5] | 142.9 [142.8, 143.1] | 0.1 |
| `central_full` | 75.3 [65.4, 88.3] | 19.2 [17.8, 20.4] | 7.2 [6.2, 8.0] | 0.0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 75.3 [65.4, 88.3] | 19.2 [17.8, 20.4] | 7.2 [6.2, 8.0] | 0.0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `greedy_nearest` | 68.7 [57.0, 78.3] | 19.8 [18.2, 21.6] | 7.6 [6.2, 8.6] | 0.3 [0.0, 0.8] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `cbba_plain` | 73.3 [60.0, 88.3] | 18.0 [16.2, 20.0] | 6.6 [5.2, 7.8] | 0.2 [0.0, 0.5] | 5 | 0 | 0 | 0.3 | 0.0 | 0.1 |

## Acceptance checks

- **AT-05**: FAIL — on-time rate, healthy -> hub loss: pact 86.3 -> 86.3 % (drop 0.0 %, gate <= 15 %); central_hub_loss 86.3 -> 56.8 % (drop 34.1 %, gate > 40 %)
- **Invariants I1 / I3**: PASS — 100 runs completed; fenced systems: duplicate deliveries 0, zombie pickups 0; unfenced (cbba_plain, not gated): duplicate deliveries 15 in 20 runs (the AT-12 policy sweep is `make sweep`)

## Systems

- `pact`: decentralised bid / claim / back-off over the radio; every drone and depot keeps its own CRDT replica, synchronised by gossip over the simulated network; epoch-fenced leases on local clocks, depot arbitration, the scenario partition policy (STRICT / QUORUM / OPTIMISTIC_BOUNDED) and failure detection with physical evidence.
- `central_full`: central hub, global greedy assignment every auction period, no radio limits, never fails (upper bound).
- `central_hub_loss`: the same hub; `kill_service(central_hub)` stops all new dispatches.
- `greedy_nearest`: decentralised, nearest feasible task first, no priorities, deadlines or bids.
- `cbba_plain`: the PACT radio auction on an unfenced board: no atomic claim, no leases, no depot arbitration (duplicates are expected and not gated).

## Recovery after a carrier failure (AT-06 measure, every system)

at06_drone_failure, 8 seeds per system: the first drone to pick up a parcel after 120 s is killed 10 s later. Detection = kill -> declaration (pact: the origin depot's `peer_failed`; baselines: the fixed `SIM.tFailed` stand-in). Recovery = declaration -> replacement claimed by another drone. Medians over the runs where the victim still carried its parcel.

| System | Runs | Detection median s | Recovery median s | Kill -> claimed median s | Not recovered |
|---|---|---|---|---|---|
| `pact` | 8 | 3.7 | 6.2 | 9.9 | 1 |
| `central_full` | 8 | 60.0 | 1.6 | 61.7 | 0 |
| `central_hub_loss` | 8 | 60.0 | 1.6 | 61.7 | 0 |
| `greedy_nearest` | 8 | 60.0 | 6.3 | 66.3 | 0 |
| `cbba_plain` | 7 | 60.1 | 7.8 | 67.9 | 0 |
