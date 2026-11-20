# Radio-shadow-aware ownership ("planned silence"): `pact` vs `pact_fixed_lease`

300 runs: 5 scenario(s) x 2 systems x 30 seed(s), 900 s of simulated time each, identical seeds per system (run i uses the scenario seed + i). Values are means with a 95 % percentile-bootstrap CI; **Δ** is the paired per-seed difference `pact` − `pact_fixed_lease` with its own bootstrap CI. Simulation only: no claim of real-world flight readiness.

- `pact_fixed_lease`: PACT before Decision 22: every pre-pickup lease is the fixed 20 s; the origin depot re-opens a job whose renewals stop for 20 x 1.02 + 2 s.
- `pact`: radio-shadow-aware ownership: drones learn a shared radio shadow map (CRDT, gossiped), forecast the longest radio-dark stretch on the way to the pickup, and announce a longer lease before they go silent (planned silence, capped at 90 s); urgent jobs prefer drones that stay in coverage (connectivity term in the bid).

**False re-opens** = lease expiries whose owner was alive (not killed or removed); in these scenarios no drone is killed, so every lease expiry is a false failover. **Planned silences** = leases announced above the base length ahead of a forecast shadow.

## dm_canyon_shadow

| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |
|---|---|---|---|
| On-time rate % | 95.5 [91.6, 98.4] | 96.6 [92.2, 100.0] | +1.1 [-4.1, +5.6] |
| Delivered | 34.1 [32.9, 35.3] | 36.1 [34.8, 37.2] | +1.9 [+0.8, +3.2] |
| Mean lateness s | 0.5 [0.2, 1.0] | 0.1 [0.0, 0.3] | -0.4 [-0.9, +0.0] |
| Lease expiries (re-opens) | 14.33 [12.53, 16.17] | 6.33 [5.37, 7.40] | -8.00 [-9.73, -6.33] |
| False re-opens (owner alive) | 14.33 [12.53, 16.17] | 6.33 [5.37, 7.40] | -8.00 [-9.73, -6.33] |
| Lease expiries after 300 s (map learned) | 9.23 [7.90, 10.63] | 2.60 [1.93, 3.30] | -6.63 [-8.13, -5.13] |
| Planned silences | 0.0 | 14.1 [12.5, 15.8] | +14.1 [+12.6, +15.8] |
| Depot refusals | 0.00 | 0.00 | 0.00 |
| Duplicate deliveries (total) | 0 | 0 | +0 |
| Zombie pickups (total) | 0 | 0 | +0 |
| Loss of separation (total) | 0 | 0 | +0 |
| Msgs / drone / min | 99.0 [97.3, 100.6] | 106.5 [104.5, 108.4] | +7.5 [+5.6, +9.5] |
| Radio bytes / drone / s | 1879 [1841, 1918] | 2047 [2002, 2092] | +168 [+154, +183] |

## dm_canyon_partition

| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |
|---|---|---|---|
| On-time rate % | 82.1 [75.9, 87.6] | 82.1 [76.6, 87.5] | +0.0 [-6.3, +6.0] |
| Delivered | 26.4 [25.0, 27.7] | 29.3 [27.7, 30.9] | +2.9 [+1.6, +4.3] |
| Mean lateness s | 1.6 [0.9, 2.3] | 1.0 [0.6, 1.4] | -0.6 [-1.0, -0.1] |
| Lease expiries (re-opens) | 11.43 [10.00, 13.00] | 6.93 [6.03, 7.87] | -4.50 [-6.03, -3.00] |
| False re-opens (owner alive) | 11.43 [10.00, 13.00] | 6.93 [6.03, 7.87] | -4.50 [-6.03, -3.00] |
| Lease expiries after 300 s (map learned) | 6.33 [5.30, 7.47] | 3.20 [2.43, 4.03] | -3.13 [-4.43, -1.83] |
| Planned silences | 0.0 | 11.1 [9.8, 12.5] | +11.1 [+9.9, +12.6] |
| Depot refusals | 0.00 | 0.00 | 0.00 |
| Duplicate deliveries (total) | 0 | 0 | +0 |
| Zombie pickups (total) | 0 | 0 | +0 |
| Loss of separation (total) | 0 | 0 | +0 |
| Msgs / drone / min | 100.7 [98.1, 103.4] | 105.5 [103.1, 107.9] | +4.8 [+2.9, +7.0] |
| Radio bytes / drone / s | 1663 [1633, 1692] | 1838 [1808, 1868] | +175 [+156, +193] |

## dm_healthy

| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |
|---|---|---|---|
| On-time rate % | 97.5 [95.0, 99.3] | 99.2 [98.0, 100.0] | +1.7 [-0.4, +4.0] |
| Delivered | 37.3 [36.1, 38.5] | 38.1 [36.9, 39.4] | +0.8 [+0.3, +1.3] |
| Mean lateness s | 0.2 [0.0, 0.4] | 0.0 [0.0, 0.1] | -0.2 [-0.4, +0.0] |
| Lease expiries (re-opens) | 7.80 [6.43, 9.13] | 4.13 [3.47, 4.80] | -3.67 [-4.63, -2.77] |
| False re-opens (owner alive) | 7.80 [6.43, 9.13] | 4.13 [3.47, 4.80] | -3.67 [-4.63, -2.77] |
| Lease expiries after 300 s (map learned) | 5.03 [4.10, 5.97] | 1.97 [1.47, 2.53] | -3.07 [-3.90, -2.30] |
| Planned silences | 0.0 | 9.0 [7.4, 10.5] | +9.0 [+7.5, +10.6] |
| Depot refusals | 0.00 | 0.00 | 0.00 |
| Duplicate deliveries (total) | 0 | 0 | +0 |
| Zombie pickups (total) | 0 | 0 | +0 |
| Loss of separation (total) | 0 | 0 | +0 |
| Msgs / drone / min | 123.5 [119.5, 127.6] | 121.7 [118.1, 125.1] | -1.9 [-3.8, +0.1] |
| Radio bytes / drone / s | 2312 [2278, 2344] | 2528 [2491, 2562] | +216 [+205, +227] |

## s0_healthy

| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |
|---|---|---|---|
| On-time rate % | 72.5 [62.0, 82.0] | 72.5 [62.0, 82.0] | 0.0 |
| Delivered | 19.0 [18.1, 20.0] | 19.0 [18.1, 20.0] | 0.0 |
| Mean lateness s | 0.9 [0.1, 2.2] | 0.9 [0.1, 2.2] | 0.0 |
| Lease expiries (re-opens) | 0.00 | 0.00 | 0.00 |
| False re-opens (owner alive) | 0.00 | 0.00 | 0.00 |
| Lease expiries after 300 s (map learned) | 0.00 | 0.00 | 0.00 |
| Planned silences | 0.0 | 0.0 | 0.0 |
| Depot refusals | 0.00 | 0.00 | 0.00 |
| Duplicate deliveries (total) | 0 | 0 | +0 |
| Zombie pickups (total) | 0 | 0 | +0 |
| Loss of separation (total) | 0 | 0 | +0 |
| Msgs / drone / min | 77.3 [76.3, 78.4] | 77.3 [76.3, 78.4] | 0.0 |
| Radio bytes / drone / s | 1622 [1589, 1654] | 1808 [1773, 1841] | +186 [+183, +188] |

## s1_hub_loss

| Metric | `pact_fixed_lease` | `pact` | Δ (paired) |
|---|---|---|---|
| On-time rate % | 72.5 [62.0, 82.0] | 72.5 [62.0, 82.0] | 0.0 |
| Delivered | 19.0 [18.1, 20.0] | 19.0 [18.1, 20.0] | 0.0 |
| Mean lateness s | 0.9 [0.1, 2.2] | 0.9 [0.1, 2.2] | 0.0 |
| Lease expiries (re-opens) | 0.00 | 0.00 | 0.00 |
| False re-opens (owner alive) | 0.00 | 0.00 | 0.00 |
| Lease expiries after 300 s (map learned) | 0.00 | 0.00 | 0.00 |
| Planned silences | 0.0 | 0.0 | 0.0 |
| Depot refusals | 0.00 | 0.00 | 0.00 |
| Duplicate deliveries (total) | 0 | 0 | +0 |
| Zombie pickups (total) | 0 | 0 | +0 |
| Loss of separation (total) | 0 | 0 | +0 |
| Msgs / drone / min | 77.3 [76.3, 78.4] | 77.3 [76.3, 78.4] | 0.0 |
| Radio bytes / drone / s | 1622 [1589, 1654] | 1808 [1773, 1841] | +186 [+183, +188] |

## Recovery after a carrier failure (at06_drone_failure, AT-06 measure)

30 seeds per system: the first drone to pick up a parcel after 120 s is killed 10 s later. Detection = kill -> the origin depot's `peer_failed`; recovery = declaration -> replacement claimed by another drone. Medians over the runs where the victim still carried its parcel.

| System | Runs | Detection median s | Recovery median s | Kill -> claimed median s | Kill -> claimed mean s | Not recovered |
|---|---|---|---|---|---|---|
| `pact_fixed_lease` | 30 | 3.7 | 5.6 | 9.7 | 13.3 [9.6, 17.3] | 1 |
| `pact` | 30 | 3.7 | 5.6 | 9.7 | 13.3 [9.6, 17.3] | 1 |

## Invariants

- I1 / I3 over all 300 runs: duplicate deliveries + zombie pickups = **0** (must be 0).

Reproduce: `cd sim3d && npm run radiomap` (options: `--seeds=N --window=S --scenarios=a,b --recovery=N --jobs=N --out=dir`).
