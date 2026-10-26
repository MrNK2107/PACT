# PACT: Partition-Aware Coordination for Transport

A deterministic simulator for **decentralised drone logistics**. A fleet of virtual drones shares out delivery jobs, charges at scarce pads, keeps separation and carries on through faults (closed airspace, storms, radio dead zones, pad outages, drone loss, hub loss) **without a central controller**. A benchmark compares that against central and greedy baselines.

> **Simulation only.** Motion is simplified kinematics, the battery is an accelerated toy model, and nothing here is a flight-readiness model. PACT does not connect to real drones.

![The sim3d viewer: the coastal_metro map running s0_healthy, with telemetry, the order board and the fleet list](docs/img/sim3d.png)

## What's in the repo

| Path | What it is |
|---|---|
| `sim3d/` | The simulator and 3D viewer: TypeScript, Vite, React 18, React Three Fiber, vitest. Everything that runs lives here. |
| `sim3d/maps/`, `sim3d/scenarios/` | 8 maps (2 to 12 km) and about 30 YAML scenarios. Scenario files are the only way to change behaviour in experiments (NFR-6). |
| `docs/` | Problem statement, assumptions, approach, the agent-first PRD (`04_agent_first_PRD.md`), evaluation plan, risks and `DECISIONS.md`. |
| `results/` | Output of `make bench` (`summary.md`, `results.csv`, `bench.json`), `make sweep` (`sweep/sweep.md`, `.csv`, `.json`) and `make plots` (`plots/*.svg`). |
| `Makefile` | `test`, `scenarios`, `lint`, `bench`, `sweep`, `plots`, `demo`. |

The PRD describes a Python package layout (`pact/…`). The implementation is the TypeScript simulator in `sim3d/`; `docs/DECISIONS.md` records where and why it departs from the PRD.

## Quick start

You need Node 18 or newer.

```bash
cd sim3d
npm install
npm run dev          # http://localhost:5173
```

URL options: `?map=<id>&scenario=<name>` picks a world and scenario, `?system=<id>` runs a baseline instead of PACT (also in the toolbar's System picker), `?autostart` starts the run, `?view=overview` and `?cam=px,py,pz,tx,ty,tz` set the camera. For example, to watch the central hub fail at t = 180 s while PACT carries on, open `/?scenario=s1_hub_loss&system=central_hub_loss&autostart` next to `/?scenario=s1_hub_loss&autostart`.

The toolbar has map and scenario pickers, pause/reset, sim speed (0.5x to 8x) and add/remove drone. The side panels show telemetry, the order board, the fleet and an inspector (click any drone, building, depot or drop point).

## Commands

| `make` target | npm equivalent (in `sim3d/`) | What it does |
|---|---|---|
| `make test` | `npm test` | Unit and property tests: world generation, maps, scenarios, planner, pads, radio, weather, terrain, baselines, eval (about 2 min). |
| `make scenarios` | `npm run scenarios` | Scenario acceptance suite: every scenario runs headless for 900 simulated seconds against its tier gate, plus the invariants and AT-01 determinism (about 1 min). `RUN_HEAVY=1` adds the 12 km map. |
| `make lint` | `npm run typecheck` | `tsc --noEmit`. |
| `make bench` | `npm run bench -- --seeds=5 --window=900` | Runs scenario x system x seed and writes `results/` (about 2 min with 5 seeds). Options: `SEEDS=30 WINDOW=900 SCENARIOS=a,b SYSTEMS=x,y`. Exits non-zero if a run breaks I1 or I3; add `--strict` to also fail on AT-05. |
| `make sweep` | `npm run sweep -- --seeds=30 --window=900` | AT-12 policy sweep: scenario x system x policy x seed, writes `results/sweep/` (about 19 min for 540 runs). Options: `SWEEP_SEEDS`, `SWEEP_WINDOW`; `--scenarios=` / `--systems=` on the npm script. Exits non-zero if a run is missing (crashed) or a fenced system breaks I1 / I3. |
| `make plots` | `npm run plots` | Renders `results/plots/bench_on_time.svg` and `sweep_pareto.svg` from the bench and sweep JSON (no plotting dependency). |
| `make demo` | `npm run dev -- --open "/?scenario=s_scripted_demo&autostart"` | Opens the scripted demo scenario in the live viewer. |

`npm run build` makes a production bundle in `sim3d/dist/`.

## How coordination works

- **Allocation, no controller:** each idle drone scores the open jobs (priority, distance, lateness, energy, pad contention). Hard constraints are payload and pessimistic energy, which must cover the reserve plus reaching a pad (I5). The drone broadcasts a `CLAIM` over a range-limited radio and backs off if a neighbour outbids it.
- **Ownership:** claims carry an epoch and a lease that heartbeats renew. When a lease lapses before pickup, the job re-opens at a higher epoch and the old owner stops (zombie-stop, I3). The depot hands the parcel only to the highest valid epoch, and ownership is sticky after pickup, so no parcel is delivered twice (I1).
- **Separation:** drones share intent in their heartbeats and resolve conflicts with a priority order that every drone evaluates the same way. Onboard sensing keeps separation working even with the radio off (I4).
- **Determinism:** fixed 20 Hz steps, seeded RNGs and ordered iteration. The structured JSONL event log is hashed, and two runs with the same scenario and seed must give the same hash (AT-01).

## Benchmark: systems under test (TC-11 / TC-12)

| System | Description |
|---|---|
| `pact` | The decentralised protocol above (the default). |
| `central_full` | A central hub with global knowledge assigns idle drones to jobs (global greedy) every auction period. It never fails, so it is the upper bound. |
| `central_hub_loss` | The same hub, but `kill_service(central_hub)` takes it down. Drones finish the job they hold, then go home. |
| `greedy_nearest` | Decentralised. Each drone grabs the nearest feasible job, with no priorities, deadlines or bids. |
| `cbba_plain` | The same radio auction as `pact`, on an **unfenced** board: no atomic claim, no leases, no depot arbitration. A drone treats a job as free unless it can hear the drone holding it, so claims made out of radio range become duplicate dispatches. It is expected to break I1 / I3, so the bench reports its duplicates but does not gate on them. |

A scenario can set `system:`. The bench runner overrides it so every system runs on the same seeds, worlds, workloads and faults. Metrics come from the event log only. The headline metric is the **on-time rate**: of the jobs that fell due inside the window, the share delivered by their deadline. Means come with 95 % bootstrap CIs. `s1_hub_loss` kills the hub at t = 180 s, and AT-05 checks that PACT degrades by 15 % or less while `central_hub_loss` degrades by more than 40 %. See `results/summary.md` for the latest numbers.

![On-time rate by system and scenario](results/plots/bench_on_time.svg)

`make bench` (5 seeds x 900 s, 100 runs): fenced systems had 0 duplicate deliveries and 0 zombie pickups; `cbba_plain` had 14 duplicate deliveries over its 20 runs. AT-05 still fails narrowly at 900 s (`central_hub_loss` drops 34 % against the > 40 % gate; it passes at 1800 s, see `docs/DECISIONS.md` Decision 13). The window choice is left open.

### AT-12 policy sweep

`make sweep` crosses the ownership protocol (`pact` fenced vs `cbba_plain` unfenced) with three energy-reserve policies (`policy.soc_reserve` 0.1 / 0.2 / 0.3) on `s6_battery_crunch`, `dm_canyon_shadow` and `ip_radio_clutter`, 30 seeds x 900 s (540 runs, about 19 min). The PRD's partition policies are not swept because the network model they need does not exist yet. Latest run (`results/sweep/sweep.md`): **AT-12 PASS**, 540/540 runs completed, 0 I1 / I3 violations for `pact`.

- `dm_canyon_shadow` (urban radio canyons, 8 drones): `pact` 99.4 / 99.4 / 98.8 % on time at reserve 10 / 20 / 30 %, with 0 violations and 38.7-39.7 deliveries per run. `cbba_plain` 97.3 / 97.8 / 95.7 % on time, but with 17.6 / 16.4 / 15.5 duplicate deliveries per run and only 22.7-25.1 distinct deliveries, because shadowed links hide claims and drones fly the same parcels. (This scenario used to crash world generation at seed 31006; see `docs/DECISIONS.md` Decision 15.)
- `ip_radio_clutter` (degraded radio): `pact` 94.8 / 93.4 / 91.3 % on time, with 0 violations. `cbba_plain` 90.1 / 89.9 / 88.3 %, with 8.4 / 7.5 / 6.2 duplicate deliveries per run, and about 7 fewer distinct deliveries per run (18.9-20.7 against 26.6-27.3).
- `s6_battery_crunch`: the reserve is the trade-off. At 10 % `pact` reaches 54.4 % on time against 48.6 % at 20 % (overlapping CIs), but its 30 runs logged 13 battery-depleted events (`cbba_plain`: 13 as well); at 20 % and 30 % there were none. `cbba_plain` has few duplicates here (0.1-0.5 per run), since the drones mostly stay within radio range. One seed (60) of this scenario has a slightly different world after the depot-siting fix, so these numbers moved by under 1 point from the previous run.
- The Pareto rings only use on-time rate and violations. Battery depletion is listed in the table but is not part of the front.

![AT-12 Pareto data](results/plots/sweep_pareto.svg)

## Maps and scenarios

| Map | Size | Tier | Notes |
|---|---|---|---|
| `coastal_metro` | 4 km | standard | PRD example world; S0 healthy, S1 hub loss, S6 battery crunch, S7 urgent burst, zone closure, scripted demo |
| `dense_metro_core` | 2.5 km | hard | Downtown towers, rooftop-only drops, radio shadows, low ceiling |
| `industrial_port` | 3 km | standard | Port and cranes, hub outage, storm front, radio clutter |
| `flatland_rural` | 8 km | standard | Long hauls, gale, pad outages, public pads |
| `river_valley` | 5 km | hard | Hills as obstacles, valley radio shadow, ridge storm |
| `island_archipelago` | 6 km | hard | Islands, over-water legs, sea fog ceiling, gale |
| `harbour_metro_xl` | 12 km | stress | Scalability (30 drones) |
| `coastal_testbed` | 2 km | tutorial | Small fixture for the automated tests |

Supported faults include `urgent_job_burst`, `close_zone`, `radio_blackout`, `pad_outage` / `depot_outage`, `weather_front`, `storm_cell`, `altitude_cap`, `battery_drain`, `kill_drone` and `kill_service`. `partition`, `link_loss` and `clock_drift` are parsed but logged as unsupported until the network model (TC-02) exists. `sim3d/README.md` covers the world generator, scenario schema, tiers and module layout in detail.

## Status and known limits

- Done: deterministic engine, procedural worlds and maps, workload generator, fault injector, energy model, path planner, decentralised allocation with epoch-fenced leases and depot arbitration, safety separation, 3D viewer, scenario acceptance suite, and the baselines plus bench runner.
- Not yet: the network model with partitions and gossip (TC-02/04), the CRDT replica (TC-03), the failure detector (TC-09), partition policies `STRICT` / `QUORUM` / `OPTIMISTIC_BOUNDED`, and the replay viewer (TC-13). AT-12 sweeps the energy-reserve policy instead of the partition policies until those exist.
- The fleet is capped at one drone per charging pad. A scenario asking for more drones runs fewer and logs `fleet_capped`; for example, `s0_healthy` asks for 12 and runs 6.
- The radio is a disc model with dead zones, and planning is 2.5D over altitude layers. Ground vehicles are decorative.
