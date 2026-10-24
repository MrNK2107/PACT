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
| `results/` | Output of `make bench`: `summary.md`, `results.csv`, `bench.json`. |
| `Makefile` | `test`, `scenarios`, `lint`, `bench`, `demo`. |

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

A scenario can set `system:`. The bench runner overrides it so every system runs on the same seeds, worlds, workloads and faults. Metrics come from the event log only. The headline metric is the **on-time rate**: of the jobs that fell due inside the window, the share delivered by their deadline. Means come with 95 % bootstrap CIs. `s1_hub_loss` kills the hub at t = 180 s, and AT-05 checks that PACT degrades by 15 % or less while `central_hub_loss` degrades by more than 40 %. See `results/summary.md` for the latest numbers.

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
- Not yet: the network model with partitions and gossip (TC-02/04), the CRDT replica (TC-03), the failure detector (TC-09), partition policies `STRICT` / `QUORUM` / `OPTIMISTIC_BOUNDED`, the `cbba_plain` baseline, plots, and the replay viewer (TC-13).
- The fleet is capped at one drone per charging pad. A scenario asking for more drones runs fewer and logs `fleet_capped`; for example, `s0_healthy` asks for 12 and runs 6.
- The radio is a disc model with dead zones, and planning is 2.5D over altitude layers. Ground vehicles are decorative.
