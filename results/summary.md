# AeroPACT benchmark summary

Simulation results indicate relative merit, not real-world performance (assumption E1). Mean +/- 95% CI over seeds.

| scenario | system | runs | on-time | completion | duplicate rate | median recovery (s) | msgs/drone/min | invariants |
|---|---|---|---|---|---|---|---|---|
| s0_healthy | cbba_plain | 1 | 63.3% +/- 0.0 | 73.3% +/- 0.0 | 0.0% +/- 0.0 | n/a | 117.2 +/- 0.0 | 1/1 |
| s0_healthy | central | 1 | 66.7% +/- 0.0 | 86.7% +/- 0.0 | 0.0% +/- 0.0 | n/a | 116.6 +/- 0.0 | 1/1 |
| s0_healthy | greedy_nearest | 1 | 40.0% +/- 0.0 | 53.3% +/- 0.0 | 6.7% +/- 0.0 | n/a | n/a | 0/1 |
| s0_healthy | pact_optimistic | 1 | 66.7% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.8 +/- 0.0 | 1/1 |
| s0_healthy | pact_quorum | 1 | 66.7% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.8 +/- 0.0 | 1/1 |
| s0_healthy | pact_strict | 1 | 66.7% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.7 +/- 0.0 | 1/1 |
| s1_hub_loss | cbba_plain | 1 | 73.3% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 116.9 +/- 0.0 | 1/1 |
| s1_hub_loss | central | 1 | 20.0% +/- 0.0 | 20.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 107.1 +/- 0.0 | 1/1 |
| s1_hub_loss | greedy_nearest | 1 | 46.7% +/- 0.0 | 66.7% +/- 0.0 | 3.3% +/- 0.0 | n/a | 116.7 +/- 0.0 | 0/1 |
| s1_hub_loss | pact_optimistic | 1 | 70.0% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.7 +/- 0.0 | 1/1 |
| s1_hub_loss | pact_quorum | 1 | 66.7% +/- 0.0 | 83.3% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.7 +/- 0.0 | 1/1 |
| s1_hub_loss | pact_strict | 1 | 66.7% +/- 0.0 | 80.0% +/- 0.0 | 0.0% +/- 0.0 | n/a | 119.8 +/- 0.0 | 1/1 |
| s3_split_brain | cbba_plain | 1 | 70.0% +/- 0.0 | 83.3% +/- 0.0 | 0.0% +/- 0.0 | n/a | 124.0 +/- 0.0 | 1/1 |
| s3_split_brain | central | 1 | 66.7% +/- 0.0 | 86.7% +/- 0.0 | 0.0% +/- 0.0 | n/a | 123.9 +/- 0.0 | 1/1 |
| s3_split_brain | greedy_nearest | 1 | 56.7% +/- 0.0 | 70.0% +/- 0.0 | 6.7% +/- 0.0 | n/a | 123.8 +/- 0.0 | 0/1 |
| s3_split_brain | pact_optimistic | 1 | 66.7% +/- 0.0 | 83.3% +/- 0.0 | 0.0% +/- 0.0 | n/a | 126.2 +/- 0.0 | 1/1 |
| s3_split_brain | pact_quorum | 1 | 56.7% +/- 0.0 | 76.7% +/- 0.0 | 0.0% +/- 0.0 | n/a | 124.7 +/- 0.0 | 1/1 |
| s3_split_brain | pact_strict | 1 | 66.7% +/- 0.0 | 83.3% +/- 0.0 | 0.0% +/- 0.0 | n/a | 124.7 +/- 0.0 | 1/1 |
