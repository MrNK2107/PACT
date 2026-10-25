# PACT AT-12 policy sweep

360 runs: scenario x system x policy x 30 seed(s), 900 s of simulated time each. Values are means with a 95 % bootstrap CI. Simulation only.

Policies vary `policy.soc_reserve`. The partition policies STRICT / QUORUM / OPTIMISTIC_BOUNDED need the network model, which is not implemented, so they are not swept. Systems: `pact` (fenced: atomic claims, leases, depot arbitration) and `cbba_plain` (unfenced).

**Violations** = duplicate deliveries + zombie pickups per run. **Pareto** = not dominated within the scenario on (on-time rate up, violations down).

- `reserve_10`: energy reserve 10 %
- `reserve_20`: energy reserve 20 % (default)
- `reserve_30`: energy reserve 30 %

## s6_battery_crunch

| System | Policy | Runs | On-time rate % | Delivered | Violations / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|
| `pact` | `reserve_10` | 30 | 54.0 [47.7, 61.2] | 11.3 [10.7, 12.0] | 0.00 | 13 | yes |
| `cbba_plain` | `reserve_10` | 30 | 55.2 [48.2, 63.1] | 10.8 [10.2, 11.5] | 0.53 [0.30, 0.77] | 14 | yes |
| `pact` | `reserve_20` | 30 | 48.6 [39.6, 58.0] | 11.7 [11.2, 12.3] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_20` | 30 | 47.5 [38.6, 56.8] | 11.5 [11.0, 12.1] | 0.23 [0.10, 0.40] | 0 |  |
| `pact` | `reserve_30` | 30 | 46.1 [37.1, 55.8] | 12.0 [11.5, 12.6] | 0.00 | 0 |  |
| `cbba_plain` | `reserve_30` | 30 | 45.3 [36.4, 55.0] | 12.0 [11.4, 12.5] | 0.10 [0.00, 0.20] | 0 |  |

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

- **AT-12**: PASS — 360/360 runs completed without crashing; fenced-system I1 / I3 violations 0
