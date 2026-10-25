# PACT benchmark summary

100 runs: 4 scenario(s) x 5 system(s) x 5 seed(s), 900 s of simulated time each.
Metrics come from the event log only. Values are means with a 95 % bootstrap CI in brackets. Simulation only: no claim of real-world flight readiness.

**On-time rate** = tasks that fell due inside the window and were delivered by their deadline, divided by the tasks that fell due.

## s0_healthy

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|
| `pact` | 90.3 [83.4, 97.1] | 20.6 [19.6, 21.4] | 0.0 | 0.5 [0.0, 1.4] | 0 | 0 | 0 | 0.1 |
| `central_full` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 0.0 | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.1 |
| `central_hub_loss` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 0.0 | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.1 |
| `greedy_nearest` | 80.6 [73.1, 90.3] | 21.2 [20.0, 22.2] | 0.0 | 0.7 [0.0, 2.1] | 0 | 0 | 0 | 0.3 |
| `cbba_plain` | 86.3 [81.1, 93.1] | 19.2 [17.6, 21.0] | 0.0 | 1.8 [0.0, 4.1] | 4 | 0 | 0 | 0.1 |

## s1_hub_loss

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|
| `pact` | 90.3 [83.4, 97.1] | 20.6 [19.6, 21.4] | 17.4 [16.6, 18.0] | 0.5 [0.0, 1.4] | 0 | 0 | 0 | 0.1 |
| `central_full` | 86.3 [76.6, 96.0] | 20.2 [19.2, 21.2] | 16.6 [16.0, 17.4] | 1.0 [0.0, 3.1] | 0 | 0 | 0 | 0.2 |
| `central_hub_loss` | 56.8 [53.4, 59.4] | 7.6 [7.0, 8.4] | 4.0 [3.4, 4.6] | 0.0 | 0 | 0 | 0 | 0.1 |
| `greedy_nearest` | 80.6 [73.1, 90.3] | 21.2 [20.0, 22.2] | 18.0 [16.4, 19.4] | 0.7 [0.0, 2.1] | 0 | 0 | 0 | 0.1 |
| `cbba_plain` | 86.3 [81.1, 93.1] | 19.2 [17.6, 21.0] | 16.2 [15.2, 17.2] | 1.8 [0.0, 4.1] | 4 | 0 | 0 | 0.1 |

## s6_battery_crunch

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|
| `pact` | 60.1 [52.3, 72.2] | 11.8 [11.4, 12.0] | 10.6 [10.2, 11.0] | 0.7 [0.0, 1.6] | 0 | 0 | 0 | 0.0 |
| `central_full` | 56.8 [52.3, 62.3] | 11.6 [11.2, 12.0] | 10.4 [9.6, 11.0] | 2.3 [0.0, 6.1] | 0 | 0 | 0 | 0.0 |
| `central_hub_loss` | 56.8 [52.3, 62.3] | 11.6 [11.2, 12.0] | 10.4 [9.6, 11.0] | 2.3 [0.0, 6.1] | 0 | 0 | 0 | 0.1 |
| `greedy_nearest` | 35.0 [23.9, 46.9] | 14.2 [13.6, 14.8] | 12.8 [11.8, 13.6] | 0.0 | 0 | 0 | 0 | 0.0 |
| `cbba_plain` | 58.3 [48.7, 71.1] | 11.6 [11.2, 12.0] | 10.4 [10.0, 10.8] | 0.7 [0.0, 1.6] | 2 | 0 | 0 | 0.0 |

## s7_urgent_burst

| System | On-time rate % | Delivered | Delivered after first fault | Mean lateness s | Dup. deliveries | Zombie pickups | Loss of sep. | Tick p95 ms |
|---|---|---|---|---|---|---|---|---|
| `pact` | 73.3 [60.0, 88.3] | 19.2 [17.4, 20.8] | 6.8 [5.2, 8.0] | 0.0 | 0 | 0 | 0 | 0.1 |
| `central_full` | 75.3 [65.4, 88.3] | 19.2 [17.8, 20.4] | 7.2 [6.2, 8.0] | 0.0 | 0 | 0 | 0 | 0.1 |
| `central_hub_loss` | 75.3 [65.4, 88.3] | 19.2 [17.8, 20.4] | 7.2 [6.2, 8.0] | 0.0 | 0 | 0 | 0 | 0.1 |
| `greedy_nearest` | 68.7 [57.0, 78.3] | 19.8 [18.2, 21.6] | 7.6 [6.2, 8.6] | 0.3 [0.0, 0.8] | 0 | 0 | 0 | 0.1 |
| `cbba_plain` | 75.0 [60.0, 90.0] | 18.6 [16.8, 20.2] | 6.6 [5.2, 7.8] | 0.0 | 4 | 0 | 0 | 0.3 |

## Acceptance checks

- **AT-05**: FAIL — on-time rate, healthy -> hub loss: pact 90.3 -> 90.3 % (drop 0.0 %, gate <= 15 %); central_hub_loss 86.3 -> 56.8 % (drop 34.1 %, gate > 40 %)
- **Invariants I1 / I3**: PASS — 100 runs completed; fenced systems: duplicate deliveries 0, zombie pickups 0; unfenced (cbba_plain, not gated): duplicate deliveries 14 in 20 runs (the AT-12 policy sweep is `make sweep`)

## Systems

- `pact`: decentralised bid / claim / back-off over the radio, epoch-fenced leases, depot arbitration.
- `central_full`: central hub, global greedy assignment every auction period, no radio limits, never fails (upper bound).
- `central_hub_loss`: the same hub; `kill_service(central_hub)` stops all new dispatches.
- `greedy_nearest`: decentralised, nearest feasible task first, no priorities, deadlines or bids.
- `cbba_plain`: the PACT radio auction on an unfenced board: no atomic claim, no leases, no depot arbitration (duplicates are expected and not gated).
