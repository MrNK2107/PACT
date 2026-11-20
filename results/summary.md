# PACT benchmark summary

720 runs: 4 scenario(s) x 6 system(s) x 30 seed(s), 900 s of simulated time each.
Metrics come from the event log only. Values are means with a 95 % bootstrap CI in brackets. Simulation only: no claim of real-world flight readiness.

**On-time rate** = tasks that fell due inside the window and were delivered by their deadline, divided by the tasks that fell due.

## s0_healthy

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 72.5 [62.0, 82.0] | 19.0 [18.1, 20.0] | 0.0 | 0.9 [0.1, 2.2] | 0 | 0 | 0 | 77.3 [76.3, 78.4] | 142.6 [142.5, 142.7] | 0.1 |
| `pact_fixed_lease` | 72.5 [62.0, 82.0] | 19.0 [18.1, 20.0] | 0.0 | 0.9 [0.1, 2.2] | 0 | 0 | 0 | 77.3 [76.3, 78.4] | 142.6 [142.5, 142.7] | 0.1 |
| `central_full` | 74.5 [65.9, 83.0] | 19.3 [18.5, 20.4] | 0.0 | 0.6 [0.1, 1.2] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 74.5 [65.9, 83.0] | 19.3 [18.5, 20.4] | 0.0 | 0.6 [0.1, 1.2] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 66.5 [55.8, 77.0] | 19.9 [19.0, 20.9] | 0.0 | 0.6 [0.1, 1.4] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `cbba_plain` | 73.1 [64.5, 81.9] | 18.9 [18.0, 20.0] | 0.0 | 1.4 [0.4, 2.7] | 26 | 0 | 0 | 0.3 [0.3, 0.3] | 0.0 | 0.1 |

## s1_hub_loss

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 72.5 [62.0, 82.0] | 19.0 [18.1, 20.0] | 15.9 [15.1, 16.8] | 0.9 [0.1, 2.2] | 0 | 0 | 0 | 77.3 [76.3, 78.4] | 142.6 [142.5, 142.7] | 0.1 |
| `pact_fixed_lease` | 72.5 [62.0, 82.0] | 19.0 [18.1, 20.0] | 15.9 [15.1, 16.8] | 0.9 [0.1, 2.2] | 0 | 0 | 0 | 77.3 [76.3, 78.4] | 142.6 [142.5, 142.7] | 0.1 |
| `central_full` | 74.5 [65.9, 83.0] | 19.3 [18.5, 20.4] | 15.9 [15.1, 16.7] | 0.6 [0.1, 1.2] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 44.7 [35.9, 54.4] | 7.0 [6.6, 7.5] | 3.6 [3.2, 4.0] | 0.0 | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 66.5 [55.8, 77.0] | 19.9 [19.0, 20.9] | 16.6 [15.8, 17.4] | 0.6 [0.1, 1.4] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `cbba_plain` | 73.1 [64.5, 81.9] | 18.9 [18.0, 20.0] | 15.7 [15.0, 16.6] | 1.4 [0.4, 2.7] | 26 | 0 | 0 | 0.3 [0.3, 0.3] | 0.0 | 0.1 |

## s6_battery_crunch

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 46.0 [37.4, 55.0] | 11.6 [11.1, 12.2] | 10.7 [10.3, 11.3] | 2.0 [1.1, 3.0] | 0 | 0 | 0 | 73.7 [73.3, 74.3] | 142.4 [142.3, 142.5] | 0.1 |
| `pact_fixed_lease` | 46.0 [37.4, 55.0] | 11.6 [11.1, 12.2] | 10.7 [10.3, 11.3] | 2.0 [1.1, 3.0] | 0 | 0 | 0 | 73.7 [73.3, 74.3] | 142.4 [142.3, 142.5] | 0.1 |
| `central_full` | 47.0 [37.7, 56.1] | 11.5 [11.0, 12.1] | 10.5 [10.0, 11.1] | 1.7 [0.9, 2.7] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 47.0 [37.7, 56.1] | 11.5 [11.0, 12.1] | 10.5 [10.0, 11.1] | 1.7 [0.9, 2.7] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 28.6 [22.0, 35.4] | 13.7 [13.0, 14.3] | 12.4 [11.8, 13.0] | 2.7 [0.4, 6.4] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `cbba_plain` | 47.0 [38.2, 56.0] | 11.4 [10.9, 12.0] | 10.4 [9.8, 11.0] | 1.3 [0.5, 2.1] | 7 | 0 | 0 | 0.3 [0.3, 0.3] | 0.0 | 0.0 |

## s7_urgent_burst

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Msgs / drone / min | Backhaul copies / depot / min | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|---|---|
| `pact` | 57.2 [47.6, 66.9] | 18.4 [17.5, 19.5] | 7.0 [6.5, 7.5] | 0.7 [0.0, 1.9] | 0 | 0 | 0 | 76.8 [76.0, 77.8] | 142.9 [142.8, 143.1] | 0.2 |
| `pact_fixed_lease` | 57.2 [47.6, 66.9] | 18.4 [17.5, 19.5] | 7.0 [6.5, 7.5] | 0.7 [0.0, 1.9] | 0 | 0 | 0 | 76.8 [76.0, 77.8] | 142.9 [142.8, 143.1] | 0.2 |
| `central_full` | 57.7 [47.3, 67.8] | 18.6 [17.7, 19.6] | 7.0 [6.5, 7.4] | 0.8 [0.0, 1.9] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `central_hub_loss` | 57.7 [47.3, 67.8] | 18.6 [17.7, 19.6] | 7.0 [6.5, 7.4] | 0.8 [0.0, 1.9] | 0 | 0 | 0 | 0.0 | 0.0 | 0.0 |
| `greedy_nearest` | 51.5 [43.2, 60.0] | 19.5 [18.7, 20.6] | 7.6 [7.1, 8.0] | 0.5 [0.0, 1.2] | 0 | 0 | 0 | 0.0 | 0.0 | 0.1 |
| `cbba_plain` | 56.3 [47.0, 66.1] | 17.7 [16.7, 18.8] | 6.6 [6.0, 7.2] | 0.5 [0.1, 1.0] | 27 | 0 | 0 | 0.3 [0.3, 0.3] | 0.0 | 0.1 |

## Acceptance checks

- **AT-05**: PASS — on-time rate, healthy -> hub loss: pact 72.5 -> 72.5 % (drop 0.0 %, gate <= 15 %); central_hub_loss 74.5 -> 44.7 % (drop 40.0 %, gate > 40 %)
- **Invariants I1 / I3**: PASS — 720 runs completed; fenced systems: duplicate deliveries 0, zombie pickups 0; unfenced (cbba_plain, not gated): duplicate deliveries 86 in 120 runs (the AT-12 policy sweep is `make sweep`)

## Systems

- `pact`: decentralised bid / claim / back-off over the radio; every drone and depot keeps its own CRDT replica, synchronised by gossip over the simulated network; epoch-fenced leases on local clocks, depot arbitration, the scenario partition policy (STRICT / QUORUM / OPTIMISTIC_BOUNDED) and failure detection with physical evidence.
- `central_full`: central hub, global greedy assignment every auction period, no radio limits, never fails (upper bound).
- `central_hub_loss`: the same hub; `kill_service(central_hub)` stops all new dispatches.
- `greedy_nearest`: decentralised, nearest feasible task first, no priorities, deadlines or bids.
- `cbba_plain`: the PACT radio auction on an unfenced board: no atomic claim, no leases, no depot arbitration (duplicates are expected and not gated).

## Recovery after a carrier failure (AT-06 measure, every system)

at06_drone_failure, 30 seeds per system: the first drone to pick up a parcel after 120 s is killed 10 s later. Detection = kill -> declaration (pact: the origin depot's `peer_failed`; baselines: the fixed `SIM.tFailed` stand-in). Recovery = declaration -> replacement claimed by another drone. Medians over the runs where the victim still carried its parcel.

| System | Runs | Detection median s | Recovery median s | Kill -> claimed median s | Not recovered |
|---|---|---|---|---|---|
| `pact` | 30 | 3.7 | 5.6 | 9.7 | 1 |
| `pact_fixed_lease` | 30 | 3.7 | 5.6 | 9.7 | 1 |
| `central_full` | 30 | 60.0 | 6.1 | 66.1 | 0 |
| `central_hub_loss` | 30 | 60.0 | 6.1 | 66.1 | 0 |
| `greedy_nearest` | 30 | 60.0 | 10.0 | 70.0 | 3 |
| `cbba_plain` | 26 | 60.0 | 11.5 | 71.6 | 2 |
