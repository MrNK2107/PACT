import type { Tier } from '../map/types';
import type { DropType } from '../world/types';

/**
 * Scenario schema — mirrors `scenario.yaml` in docs/04_agent_first_PRD.md section 9.1. Scenario files
 * are the only way to change behaviour in experiments (NFR-6). Ground coordinates in files are PRD
 * `{x, y}`; the loader maps `y` onto the world's `z` axis (see docs/DECISIONS.md).
 */

export type Priority = 1 | 2 | 3;

export interface ScriptedTaskSpec {
  /** Sim time (s) the task enters the board. */
  t: number;
  task_id?: string;
  origin_depot?: string;
  /** Either a drop-point id or a ground position (PRD x/y). */
  drop_id?: string;
  drop?: { x: number; y: number };
  /** Without drop_id / drop: sample a drop point of this cluster type. */
  cluster_type?: DropType;
  priority?: Priority;
  deadline_offset_s?: number;
  weight_kg?: number;
}

export type FaultDef =
  | { t: number; type: 'kill_drone'; id: string }
  | { t: number; type: 'link_loss'; id: string; until?: number }
  | { t: number; type: 'partition'; groups: string[][]; until?: number }
  | { t: number; type: 'kill_service'; name: string }
  | { t: number; type: 'battery_drain'; id: string; factor: number }
  | { t: number; type: 'close_zone'; id?: string; name?: string; polygon?: { x: number; y: number }[]; circle?: { x: number; y: number; r: number }; until?: number }
  | { t: number; type: 'urgent_job_burst'; n?: number; window_s?: number; priority?: Priority; cluster_type?: DropType }
  | { t: number; type: 'clock_drift'; id: string; ppm: number }
  | { t: number; type: 'pad_outage'; id: string; until?: number }
  | { t: number; type: 'depot_outage'; id: string; until?: number }
  | { t: number; type: 'radio_blackout'; id?: string; name?: string; polygon?: { x: number; y: number }[]; circle?: { x: number; y: number; r: number }; box?: { x0: number; y0: number; x1: number; y1: number }; range_factor?: number; loss?: number; max_alt_m?: number; until?: number };

export interface NoFlyFileSpec {
  id?: string;
  name?: string;
  reason?: string;
  circle?: { x: number; y: number; r: number };
  box?: { x0: number; y0: number; x1: number; y1: number };
  polygon?: { x: number; y: number }[];
  max_alt_m?: number;
  closable?: boolean;
  active?: boolean;
}

/** Radio dead zone in a scenario or map file (PRD ground coordinates: y maps onto world z). */
export interface RadioFileSpec {
  id?: string;
  name?: string;
  circle?: { x: number; y: number; r: number };
  box?: { x0: number; y0: number; x1: number; y1: number };
  polygon?: { x: number; y: number }[];
  /** Multiplier on the radio range inside the zone (0 = dark, default 0). */
  range_factor?: number;
  /** Extra packet-loss probability inside the zone (default 0). */
  loss?: number;
  max_alt_m?: number;
  active?: boolean;
}

export interface Scenario {
  name: string;
  description: string;
  /** Map this scenario runs on (maps/<id>.yaml). Size and geography come from the map. */
  map: string;
  /** Difficulty tier; falls back to the map's tier. */
  tier?: Tier;
  tags: string[];
  seed: number;
  duration_s: number;
  fleet: {
    n_drones: number;
    capacity_kg: number;
    speed_mps: number;
    battery_wh: number;
    max_drones: number;
  };
  world: {
    size_m: [number, number];
    depots: number;
    pads_per_depot: number;
    /** Standalone public charging pads outside the depots. */
    public_pads: number;
    no_fly: ('auto' | NoFlyFileSpec)[];
    /** Extra radio dead zones on top of the map's. */
    radio_zones: RadioFileSpec[];
    wind: { mean_mps: number; dir_deg?: number; gust_mps?: number };
    drop_points_per_km2: number;
  };
  workload: {
    arrival_rate_per_min: number;
    priority_mix: [number, number, number];
    /** Deadline offset range (s) per priority. */
    deadline_s: { 1: [number, number]; 2: [number, number]; 3: [number, number] };
    weight_kg: { median: number; sigma: number };
    /** Scripted tasks (inline list, or a file under scenarios/tasks/ resolved by the loader). */
    tasks: ScriptedTaskSpec[];
    /** Where the scripted tasks came from, for display. */
    tasks_file?: string;
  };
  network: {
    loss: number;
    latency_ms: [number, number];
    range_m: number;
  };
  policy: {
    partition: 'STRICT' | 'QUORUM' | 'OPTIMISTIC_BOUNDED';
    bundle_len: number;
    lease_ttl_s: number;
    gossip_period_s: number;
    auction_period_s: number;
    t_commit_s: number;
    soc_reserve: number;
    shard_m: number;
  };
  faults: FaultDef[];
}

/** Deep partial used for file contents and overrides. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
