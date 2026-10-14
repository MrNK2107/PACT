import type { Scenario } from './types';

/** PRD section 15 defaults plus the section 9.1 example values. */
export const SCENARIO_DEFAULTS: Scenario = {
  name: 'default',
  description: '',
  map: 'coastal_metro',
  tags: [],
  seed: 42,
  duration_s: 3600,
  fleet: { n_drones: 12, capacity_kg: 2.0, speed_mps: 15, battery_wh: 120, max_drones: 50 },
  world: { size_m: [4000, 4000], depots: 3, pads_per_depot: 2, no_fly: ['auto'], radio_zones: [], wind: { mean_mps: 4 }, drop_points_per_km2: 35 },
  workload: {
    arrival_rate_per_min: 2.5,
    priority_mix: [0.1, 0.3, 0.6],
    deadline_s: { 1: [240, 480], 2: [600, 1200], 3: [1200, 2400] },
    weight_kg: { median: 0.8, sigma: 0.45 },
    tasks: [],
  },
  network: { loss: 0, latency_ms: [50, 800], range_m: 1500 },
  policy: { partition: 'QUORUM', bundle_len: 3, lease_ttl_s: 20, gossip_period_s: 1.0, auction_period_s: 2.0, t_commit_s: 3, soc_reserve: 0.2, shard_m: 500 },
  faults: [],
};
