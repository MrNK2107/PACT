# AeroPACT benchmark summary

Simulation results indicate relative merit, not real-world performance (assumption E1). Mean +/- 95% CI over seeds.

| scenario | system | runs | on-time | completion | duplicate rate | median recovery (s) | msgs/drone/min | invariants |
|---|---|---|---|---|---|---|---|---|
| s0_healthy | cbba_plain | 5 | 65.6% +/- 12.0 | 80.4% +/- 10.8 | 0.0% +/- 0.0 | n/a | 116.1 +/- 0.5 | 5/5 |
| s0_healthy | central | 5 | 59.3% +/- 5.3 | 73.8% +/- 5.3 | 0.0% +/- 0.0 | n/a | 115.6 +/- 0.4 | 5/5 |
| s0_healthy | greedy_nearest | 5 | 26.4% +/- 7.6 | 31.9% +/- 9.6 | 3.2% +/- 0.4 | n/a | 113.6 +/- 1.7 | 0/5 |
| s0_healthy | pact_optimistic | 5 | 66.7% +/- 6.6 | 79.6% +/- 7.7 | 0.0% +/- 0.0 | n/a | 119.3 +/- 0.2 | 5/5 |
| s0_healthy | pact_quorum | 5 | 69.7% +/- 9.5 | 81.5% +/- 9.8 | 0.0% +/- 0.0 | n/a | 119.2 +/- 0.4 | 5/5 |
| s0_healthy | pact_strict | 5 | 70.9% +/- 9.6 | 81.9% +/- 8.5 | 0.0% +/- 0.0 | n/a | 119.3 +/- 0.2 | 5/5 |
| s1_hub_loss | cbba_plain | 5 | 65.6% +/- 5.9 | 77.9% +/- 9.1 | 0.0% +/- 0.0 | n/a | 115.8 +/- 0.5 | 5/5 |
| s1_hub_loss | central | 5 | 20.2% +/- 2.1 | 20.2% +/- 2.1 | 0.0% +/- 0.0 | n/a | 107.5 +/- 4.8 | 5/5 |
| s1_hub_loss | greedy_nearest | 5 | 30.4% +/- 13.9 | 45.1% +/- 18.8 | 4.7% +/- 3.4 | n/a | 114.7 +/- 1.3 | 0/5 |
| s1_hub_loss | pact_optimistic | 5 | 68.5% +/- 5.0 | 79.2% +/- 7.0 | 0.0% +/- 0.0 | n/a | 119.1 +/- 0.3 | 5/5 |
| s1_hub_loss | pact_quorum | 5 | 66.8% +/- 5.8 | 76.9% +/- 9.3 | 0.0% +/- 0.0 | n/a | 119.1 +/- 0.2 | 5/5 |
| s1_hub_loss | pact_strict | 5 | 67.0% +/- 1.7 | 78.1% +/- 5.3 | 0.0% +/- 0.0 | n/a | 119.5 +/- 0.2 | 5/5 |
| s3_split_brain | cbba_plain | 5 | 55.4% +/- 6.7 | 64.4% +/- 11.2 | 0.0% +/- 0.0 | 674.0 +/- 271.5 | 116.7 +/- 0.5 | 5/5 |
| s3_split_brain | central | 5 | 63.0% +/- 11.5 | 75.2% +/- 12.6 | 0.0% +/- 0.0 | n/a | 123.7 +/- 0.7 | 5/5 |
| s3_split_brain | greedy_nearest | 5 | 31.8% +/- 7.9 | 48.5% +/- 12.1 | 4.4% +/- 1.3 | 716.6 +/- 143.5 | 116.3 +/- 1.0 | 0/5 |
| s3_split_brain | pact_optimistic | 5 | 68.6% +/- 9.6 | 81.1% +/- 9.5 | 0.0% +/- 0.0 | n/a | 125.4 +/- 0.6 | 5/5 |
| s3_split_brain | pact_quorum | 5 | 67.4% +/- 13.3 | 82.0% +/- 8.6 | 0.0% +/- 0.0 | n/a | 123.6 +/- 0.7 | 5/5 |
| s3_split_brain | pact_strict | 5 | 65.0% +/- 11.4 | 76.5% +/- 13.5 | 0.0% +/- 0.0 | n/a | 124.4 +/- 0.6 | 5/5 |
