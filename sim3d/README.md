# PACT — 3D logistics simulation environment

Interactive Three.js world (React + TypeScript + Vite + React Three Fiber) for
*Decentralized Multi-Agent Coordination for Autonomous Logistics* (reviewer documents in `../docs/submission/`).

```bash
npm install
npm run dev        # http://localhost:5173  (add ?map=<id>&scenario=<name> to pick a map and scenario)
                   # other URL options: ?system=<pact|central_full|central_hub_loss|greedy_nearest|cbba_plain>, ?view=overview, ?cam=px,py,pz,tx,ty,tz, ?autostart, ?replay, ?demo, ?film
npm test           # world, map, scenario, mechanics, planner and simulation tests (fast)
npm run scenarios  # the scenario acceptance suite: every scenario against its tier gate, plus the P2P acceptance checks (about 17 min; AT-11 alone is ~16 min)
npm run bench      # scenario x system x seed benchmark, writes ../results/ (--seeds=N --window=S --scenarios=a,b --systems=x,y)
npm run build
```

> Kinematic simulation only. Motion is simplified (no aerodynamics), the energy model is a power
> model with speed / payload / wind terms accelerated for a short demo, and the battery is a toy.
> Nothing here is a flight-readiness model.

## Maps
A map (`maps/<id>.yaml`) fixes the kind of world: size, geography, depot layout, default wind, difficulty tier and a
curated scenario list. Scenarios (`scenarios/<map_id>/*.yaml`) bind to a map with `map: <id>`; they may override depots,
pads, drop density, wind and no-fly zones but not size or geography. The toolbar has a Map picker and a Scenario picker
filtered by map (`?map=<id>&scenario=<name>`; either alone also works). Switching reloads the page.

| Map | Size | Tier | Notes |
|---|---|---|---|
| `coastal_metro` | 4 km | standard | The reference example world and the original scenarios |
| `harbour_metro_xl` | 12 km | stress | Airport, port and rail; scalability runs |
| `dense_metro_core` | 2.5 km | hard | Downtown towers, rooftop-only drops, ring motorway, crowded low airspace |
| `industrial_port` | 3 km | standard | Port, warehouses, cranes, tank farms; hub-and-spoke depots |
| `flatland_rural` | 8 km | standard | Farmland, no water, wind farm, eight single-pad micro depots, long hauls |
| `island_archipelago` | 6 km | hard | 3-4 islands, a depot per island, over-water legs, sea fog and gale scenarios |
| `river_valley` | 5 km | hard | Rolling hills (30 m), river, one 5-pad hub, valley-floor radio shadow |
| `coastal_testbed` | 2 km | tutorial | Hidden fixture used by the automated tests |

A map's `geography:` block overrides generator flags (airport, port, rail, ring motorway, landmarks, specials, tall
buildings, turbines, district bias) and its `logistics:` block picks the depot layout (`distributed`, `single_hub`,
`hub_and_spoke`, `micro`). Flags a map omits are derived from its size, exactly as before.

### Scenario suite and tiers
Every map carries 3 to 6 scenarios, each with a difficulty tier (its own `tier:` or the map's). `npm run scenarios`
(`make scenarios`) runs all of them headless for up to 900 simulated seconds and checks them against the gate of their tier
plus the invariants that hold in every tier (no duplicate delivery, no pickup after a lost lease, valid scripted ids and fault
targets, every due fault fires, same event hash on two runs). `RUN_HEAVY=1` adds the 12 km scenario.

| Tier | Delivered | On time | Collisions | Structure hits | Drained batteries |
|---|---|---|---|---|---|
| tutorial | >= 5 | >= 95 % | 0 | 0 | 0 |
| standard | >= 5 | >= 80 % | 0 | not gated | 0 |
| hard | >= 3 | >= 50 % | <= 3 | not gated | <= 2 |
| stress | none | none | <= 10 | not gated | <= 10 |

## Scenarios drive everything (NFR-6)
The world, fleet, workload, policy knobs and fault script come from one YAML file under
`scenarios/<map>/` (schema in `PACT_02_Technical_Design_Document.docx`, chapter 12):

| File (`scenarios/<map>/`) | What it shows |
|---|---|
| `s0_healthy.yaml` | Reference example: 4 × 4 km city, 3 depots × 2 pads, 12 drones requested (6 fly: one per pad, `fleet_capped`), 2.5 orders/min, no faults |
| `s1_hub_loss.yaml` | S0 plus `kill_service(central_hub)` at 180 s (AT-05; a no-op for PACT, stalls the `central_hub_loss` baseline) |
| `s6_battery_crunch.yaml` | 1 pad per depot, 4 orders/min, `battery_drain ×1.5` |
| `s7_urgent_burst.yaml` | 10 priority-1 hospital jobs inside 60 s at t = 600 s (event-driven re-auction) |
| `s_close_zone.yaml` | Stadium zone closes for an event, then an incident polygon closes for 10 min |
| `s_scripted_demo.yaml` | Slow background workload plus `tasks/demo_tasks.yaml` (hand-written tasks) |
| `s10_scale.yaml` | 12 × 12 km city (144 km²), 8 depots, 30 drones |
| `test_small.yaml` | 2 × 2 km world used by the automated tests |

Scenarios added with the maps (names start with the map's prefix):

| Map | Scenarios |
|---|---|
| `dense_metro_core` | `dm_healthy`, `dm_canyon_shadow` (radio shadows between towers), `dm_event_closures` (stadium + cordon + medical burst), `dm_low_ceiling` (55 m ceiling) |
| `industrial_port` | `ip_healthy`, `ip_radio_clutter`, `ip_urgent_burst`, `ip_hub_outage` (hub chargers fail), `ip_storm_front` (gale + drifting storm), `ip_ceiling_60m` |
| `flatland_rural` | `fr_healthy`, `fr_battery_crunch`, `fr_gale` (headwind on long hauls), `fr_pad_outage`, `fr_public_pads` (three depots lose charging for good) |
| `river_valley` | `rv_healthy`, `rv_radio_shadow`, `rv_ridge_storm` (storm with a 45 m base), `rv_hub_outage` |
| `island_archipelago` | `ia_healthy`, `ia_ferry_ceiling` (sea fog), `ia_gale` |

Sample task lists live in `scenarios/tasks/` (`demo_tasks.yaml`, `burst_medical.yaml`). A scripted
task is `{ t, task_id?, origin_depot?, drop_id | drop {x,y} | cluster_type, priority, deadline_offset_s?, weight_kg? }`;
missing fields are filled from the generator's distributions. Ground coordinates in files are plan-view
`{x, y}`; `y` maps onto the world's `z` axis.

Supported faults: `urgent_job_burst`, `close_zone` (by zone id, or a new circle/polygon), `radio_blackout` (switch a radio
dead zone on, or create a temporary circle/box/polygon), `pad_outage` / `depot_outage` (charging out of
service for a window), `weather_front` (wind ramps to new speed, direction and gusts), `storm_cell` (a closed,
optionally drifting circle with extra wind) and `altitude_cap` (a ceiling over the whole map or an area), `battery_drain`,
`kill_drone` (sudden death; under `pact` the in-flight parcel is re-ordered by its origin depot once the failure
detector declares the drone failed, under the baselines after the `SIM.tFailed` stand-in; every system re-orders it
as priority 1 with a fresh window), `kill_service` (`central_hub`: only the `central_hub_loss` baseline has a hub to
lose), and the network faults (`src/net/`): `partition { groups, until? }` (drones and depots;
unlisted nodes join group 0; depots in different groups also lose their backhaul), `link_loss { id, until?, loss?, dir? }`
(asymmetric per-node radio loss), `clock_drift { id, ppm }` (a node's local clock) and `backhaul_cut { depots?, until? }`
(the depots' wired / cellular link, `network.backhaul`, default on, 10-40 ms).

## The world
Generated deterministically from `(seed, size_m, depots, pads_per_depot)` by `src/world/`:

* **Layout** (`CityLayout.ts`): coastline with a bay, a meandering river that bends into the bay, an
  airport (≥ 8 km maps), a port, a motorway ring with two through routes, jittered arterials (finer near
  the centre), a railway with stations, and districts (super-blocks) typed by centrality + noise:
  `cbd, commercial, mixed, apartments, townhouses, houses, suburb, industrial, logistics, port, park,
  campus, hospital, stadium, airport, cemetery, waterfront`. Each district has its own jittered local
  street spacing, so no two neighbourhoods share a grid.
* **Blocks** (`BlockFillers.ts`): ~45 fillers chosen per block by district-dependent weights modulated
  by a slow noise field, block size, corner-ness, arterial frontage and water. Lots are subdivided with
  jittered frontages, skipped and merged lots, random setbacks; heights come from a noise field times
  centrality; every district draws its own palette (`palettes.ts`). Landmarks (`Landmarks.ts`): a
  skyline tower, a cathedral in the old town, a broadcast mast, a gasometer.
* **Logistics** (`Depots.ts`, `DropPoints.ts`): depots are *local resources* — a parcel building with
  hand-off bays (where pickups happen), 1–3 scarce charging pads and an apron — spread with a k-centre
  rule and nudged towards demand. Drop points are grouped into demand clusters (one per district, typed
  `hospital, clinic, office, retail, residential, industrial, campus, event, park`) with demand weights
  and priority affinities, so the workload is clustered and urgent jobs lean medical.
* **Airspace** (`NoFly.ts`): circle, box and polygon no-fly zones (hospital helipads, airport, government
  quarter, substations, broadcast mast) plus *closable* zones (stadium) that faults can activate.
* **Charging** (`sim/PadBook.ts`): depot-arbitrated pad reservations. Outages displace drones onto other working pads;
  `public_pads` adds standalone pads outside the depots.
* **Radio dead zones** (`Radio.ts`, `sim/Radio.ts`): areas where the radio range shrinks and packets are lost, either
  generated from the city (urban canyons around tall buildings, clutter around cranes) or listed in a map or scenario.
* **Terrain** (`Terrain.ts`): optional hills as a height field. Buildings stand on the high side of their footprint with
  a foundation; hills close the low cruise layers in the planner. Flat maps are unchanged.
* **Wind** (`Wind.ts`): a 100 m vector field (mean + gusts) that changes energy use only (assumption T11). Weather
  faults retarget the field at runtime and storm cells add local boosts; a ceiling (`minY` on a no-fly zone) closes only
  the air above it.
* **Shards** (`Shards.ts`): 500 m hex grid, ids `H-q-r`, each assigned to its nearest depot (catchments
  for the ownership protocol's shard leases). Every task and drop point carries its shard.

## Coordinates
Metres. `+X` east, `+Z` south, `+Y` up. Entity ids are stable: `D1..D8` depots, `PAD-D1-1`, `CHG-D1-1`,
`DP-0001` drop points, `CL-001` clusters, `DIST-001` districts, `BK-00001` blocks, `B-000001` buildings,
`NFZ-*` zones, `A01..` drones, tasks `D1:00001234:ab12` (origin depot : HLC stamp : nonce).

## Layout
| Module | Role |
|---|---|
| `world/*` | Seeded, pure-data world (no Three.js): layout, fillers, depots, drop points, no-fly, wind, shards, obstacles. |
| `scenario/*` | YAML scenario loading, validation and defaults. |
| `sim/Task`, `sim/TaskBoard` | Task schema; shared board with epoch-fenced claims, lease expiry (zombie-stop), commit, depot pickup arbitration (`PICKUP_GRANT` / `TASK_TAKEN`), sticky ownership after pickup, re-orders. |
| `sim/WorkloadGenerator` | Poisson arrivals, clustered demand, priority mix, deadline and weight distributions, scripted tasks, bursts. |
| `sim/Faults` | Scripted fault injector. |
| `sim/Battery` | Power model with wind, pessimistic estimator. |
| `sim/ObstacleManager` | Static spatial hash, moving obstacles, active/closable zones. |
| `sim/PathPlanner` | Windowed A* on lazily rasterised 250 m occupancy chunks per altitude layer; `computeAvoidance` = local reactive avoidance. |
| `sim/AgentCoordinator` | Radio bus, neighbour discovery, bid scoring (priority, distance, lateness, energy, pad contention) and claim consensus. |
| `sim/LocalAgentController` | Per-drone FSM implementing `AgentController` (lease renewal, zombie-stop, urgent re-auction, depot pickup, abort). |
| `sim/systems`, `sim/CentralHub` | Systems under test (`pact`, `central_full`, `central_hub_loss`, `greedy_nearest`); the central hub's global greedy assignment. |
| `eval/metrics`, `eval/bench` | Metrics from the event log, the scenario x system x seed runner, bootstrap CIs, AT-05 / AT-12 checks (`scripts/bench.ts` writes `results/`). |
| `sim/SimulationEngine` | Fixed 20 Hz step, integration, board / workload / faults, structured JSONL events + hash. |
| `render/*` | Chunked instanced rendering with distance LOD, depots, typed drop markers with ownership rings, polygon no-fly volumes, wind arrows, shard overlay, detailed drone model. |
| `ui/*` | Controls (scenario picker), telemetry, order board, inspector, fleet, event log. |

## How coordination works (no central controller)
* **Allocation:** each idle drone scores open tasks (`w_pri·(4−priority) − w_dist·km − w_late·lateness − w_energy·need − w_pad·contention`,
  hard constraints: payload ≤ capacity, pessimistic energy ≥ reserve + reach-a-pad), broadcasts `CLAIM`;
  neighbours back off if outbid; the board's atomic claim settles races between drones out of radio range.
* **Ownership:** claims carry an epoch and a lease renewed on heartbeats; an expired pre-pickup lease
  re-opens the task with a higher epoch and the old owner stops (I3). The depot grants the parcel only
  to the highest valid epoch's owner (`TASK_TAKEN` otherwise); after pickup ownership is sticky.
* **Separation:** heartbeats carry position, velocity and intent; both ends evaluate the same priority
  order, so one yields and the other holds course. Moving obstacles always have right of way.

## Systems under test (bench baselines)
A scenario may set `system:` (default `pact`); `npm run bench` overrides it per run so all systems see identical seeds,
worlds, workloads and faults. `central_full` / `central_hub_loss`: a hub with global knowledge assigns idle drones every
`auction_period_s` (greedy over all feasible drone-task pairs, same bid score and hard constraints as PACT); after
`kill_service(central_hub)` the `central_hub_loss` hub hands out nothing and drones go home once their task is done.
`greedy_nearest`: each idle drone claims the nearest feasible task at once (no priority, deadline or neighbour bids).
`central_*` and `greedy_nearest` keep the board's epoch fencing and depot arbitration. `cbba_plain` runs the PACT radio auction on an unfenced board (no atomic claim, leases or depot arbitration), so its duplicates are expected and reported, not gated.

## Known limits
Ground vehicles are decorative. The radio is a disc (`network.loss` and dead zones degrade it). Planning
is 2.5D (altitude layers). The fleet is capped at one drone per charging pad (`fleet_capped`). Simulation only:
nothing here is a flight-readiness model.
