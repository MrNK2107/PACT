# PACT AT-12 policy sweep

540 runs: scenario x system x policy x 30 seed(s), 900 s of simulated time each. Values are means with a 95 % bootstrap CI. Simulation only.

Policies vary `policy.soc_reserve`. The partition policies STRICT / QUORUM / OPTIMISTIC_BOUNDED need the network model, which is not implemented, so they are not swept. Systems: `pact` (fenced: atomic claims, leases, depot arbitration) and `cbba_plain` (unfenced).

**Violations** = duplicate deliveries + zombie pickups per run. **Pareto** = not dominated within the scenario on (on-time rate up, violations down).

- `reserve_10`: energy reserve 10 %
- `reserve_20`: energy reserve 20 % (default)
- `reserve_30`: energy reserve 30 %

## s6_battery_crunch

| System | Policy | Runs | On-time rate % | Delivered | Violations / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|
| `pact` | `reserve_10` | 30 | 54.4 [48.0, 61.6] | 11.4 [10.7, 12.0] | 0.00 | 13 | yes |
| `cbba_plain` | `reserve_10` | 30 | 56.0 [49.0, 63.5] | 10.8 [10.2, 11.5] | 0.53 [0.30, 0.77] | 13 | yes |
| `pact` | `reserve_20` | 30 | 48.6 [39.6, 58.0] | 11.6 [11.1, 12.2] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_20` | 30 | 47.9 [38.9, 57.1] | 11.4 [10.9, 11.9] | 0.27 [0.10, 0.43] | 0 |  |
| `pact` | `reserve_30` | 30 | 46.9 [38.0, 56.6] | 12.0 [11.5, 12.6] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_30` | 30 | 46.0 [37.4, 55.8] | 11.9 [11.4, 12.5] | 0.10 [0.00, 0.20] | 0 |  |

## dm_canyon_shadow

| System | Policy | Runs | On-time rate % | Delivered | Violations / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|
| `pact` | `reserve_10` | 30 | 99.4 [98.3, 100.0] | 39.7 [38.1, 41.3] | 0.00 | 1 | yes |
| `cbba_plain` | `reserve_10` | 30 | 97.3 [94.8, 99.3] | 22.7 [21.6, 23.8] | 17.60 [16.87, 18.30] | 0 |  |
| `pact` | `reserve_20` | 30 | 99.4 [98.3, 100.0] | 39.5 [37.9, 41.1] | 0.00 | 0 | yes |
| `cbba_plain` | `reserve_20` | 30 | 97.8 [95.6, 99.7] | 24.4 [23.3, 25.5] | 16.40 [15.60, 17.23] | 0 |  |
| `pact` | `reserve_30` | 30 | 98.8 [96.8, 100.0] | 38.7 [37.3, 40.1] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_30` | 30 | 95.7 [91.8, 98.8] | 25.1 [23.8, 26.4] | 15.53 [14.73, 16.37] | 0 |  |

## ip_radio_clutter

| System | Policy | Runs | On-time rate % | Delivered | Violations / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|
| `pact` | `reserve_10` | 30 | 94.8 [90.9, 98.1] | 27.3 [26.5, 28.1] | 0.00 | 0 | yes |
| `cbba_plain` | `reserve_10` | 30 | 90.1 [85.9, 93.9] | 18.9 [17.8, 20.1] | 8.43 [7.80, 9.10] | 0 |  |
| `pact` | `reserve_20` | 30 | 93.4 [89.6, 96.6] | 26.8 [26.0, 27.7] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_20` | 30 | 89.9 [85.6, 93.7] | 19.8 [18.7, 21.0] | 7.50 [6.97, 8.10] | 0 |  |
| `pact` | `reserve_30` | 30 | 91.3 [86.9, 95.3] | 26.6 [25.8, 27.5] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_30` | 30 | 88.3 [84.2, 92.3] | 20.7 [19.7, 21.8] | 6.23 [5.73, 6.77] | 0 |  |

## Acceptance check

- **AT-12**: PASS — 540/540 runs completed without crashing; fenced-system I1 / I3 violations 0
