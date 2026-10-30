# PACT AT-12 policy sweep

240 runs: scenario x (policy x `pact` + `cbba_plain` reference) x 30 seed(s), 900 s of simulated time each. Values are means with a 95 % bootstrap CI. Simulation only.

The policy axis is the partition policy (`policy.partition`) under `pact`. `cbba_plain` has no fencing and no partition policy; it runs once per scenario as the unfenced reference (policy `unfenced`).

**Violations** = duplicate deliveries + zombie pickups per run. **Refusals** = pickups the depot refused (`task_taken`, a wasted sortie) per run. **Pareto** = not dominated within the scenario on (on-time rate up, violations down).

- `STRICT`: claim only under a live shard lease held on my side (REQ-OWN-005)
- `QUORUM`: claim only while a strict majority of the fleet roster is reachable
- `OPTIMISTIC_BOUNDED`: QUORUM, or at most 1 priority >= 2 claim without it; never priority 1

## at03_split_brain_strict

coastal_testbed: AT-03. STRICT, 6 drones, 6 orders/min; partition {D1, A01, A04} | {D2, D3, A02, A03, A05, A06} from 120 s to 420 s.

| System | Policy | Runs | On-time rate % | Delivered | Duplicates / run | Zombie pickups / run | Refusals / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|---|---|
| `pact` | `STRICT` | 30 | 76.9 [70.2, 83.4] | 28.8 [26.4, 30.9] | 0.00 | 0.00 | 0.00 | 0 |  |
| `pact` | `QUORUM` | 30 | 80.8 [75.9, 85.7] | 30.0 [28.3, 31.6] | 0.00 | 0.00 | 0.00 | 0 |  |
| `pact` | `OPTIMISTIC_BOUNDED` | 30 | 80.9 [75.7, 86.0] | 31.4 [29.7, 33.1] | 0.00 | 0.00 | 0.00 | 0 | yes |
| `cbba_plain` | `unfenced` | 30 | 84.1 [78.9, 89.0] | 28.8 [27.1, 30.6] | 3.67 [3.13, 4.17] | 0.00 | 0.00 | 0 | yes |

## dm_canyon_partition

dense_metro_core: Radio range 450 m with canyon dead zones (range x0.2, +30 % packet loss) in the tallest districts. Coordination must survive degraded links. Sweep variant: partition {D1, D4, A01, A04, A05, A08} | {D2, D3, A02, A03, A06, A07} from 300 s to 600 s.

| System | Policy | Runs | On-time rate % | Delivered | Duplicates / run | Zombie pickups / run | Refusals / run | Battery depleted | Pareto |
|---|---|---|---|---|---|---|---|---|---|
| `pact` | `STRICT` | 30 | 88.6 [83.7, 93.0] | 33.2 [31.9, 34.5] | 0.00 | 0.00 | 0.00 | 0 | yes |
| `pact` | `QUORUM` | 30 | 82.1 [75.9, 87.6] | 26.4 [25.0, 27.7] | 0.00 | 0.00 | 0.00 | 0 |  |
| `pact` | `OPTIMISTIC_BOUNDED` | 30 | 82.1 [75.7, 88.5] | 34.6 [33.4, 35.8] | 0.00 | 0.00 | 0.00 | 0 |  |
| `cbba_plain` | `unfenced` | 30 | 98.5 [96.6, 100.0] | 23.9 [22.9, 24.9] | 17.80 [17.10, 18.43] | 0.00 | 0.00 | 0 | yes |

## Acceptance check

- **AT-12**: PASS — 240/240 runs completed without crashing; fenced-system I1 / I3 violations 0
