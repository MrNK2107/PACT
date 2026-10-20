# PACT — 3D logistics simulation environment

Interactive Three.js world (React + TypeScript + Vite + React Three Fiber) for
*Decentralized Multi-Agent Coordination for Autonomous Logistics* (see `../docs/`).

```bash
npm install
npm run dev        # http://localhost:5173  (add ?map=<id>&scenario=<name> to pick a map and scenario)
                   # other URL options: ?view=overview, ?cam=px,py,pz,tx,ty,tz, ?autostart
npm test           # world, scenario, workload, task-board, planner and 10-minute simulation tests
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
| `coastal_metro` | 4 km | standard | The PRD example world and the original scenarios |
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

## Scenarios drive everything (NFR-6)
The world, fleet, workload, policy knobs and fault script come from one YAML file under
`scenarios/<map>/`, mirroring `docs/04_agent_first_PRD.md` section 9.1:

| File (`scenarios/<map>/`) | What it shows |
|---|---|
| `s0_healthy.yaml` | PRD example: 4 × 4 km city, 3 depots × 2 pads, 12 drones, 2.5 orders/min, no faults |
| `s6_battery_crunch.yaml` | 1 pad per depot, 4 orders/min, `battery_drain ×1.5` |
| `s7_urgent_burst.yaml` | 10 priority-1 hospital jobs inside 60 s at t = 600 s (event-driven re-auction) |
| `s_close_zone.yaml` | Stadium zone closes for an event, then an incident polygon closes for 10 min |
| `s_scripted_demo.yaml` | Slow background workload plus `tasks/demo_tasks.yaml` (hand-written tasks) |
| `s10_scale.yaml` | 12 × 12 km city (144 km²), 8 depots, 30 drones |
| `test_small.yaml` | 2 × 2 km world used by the automated tests |

Sample task lists live in `scenarios/tasks/` (`demo_tasks.yaml`, `burst_medical.yaml`). A scripted
task is `{ t, task_id?, origin_depot?, drop_id | drop {x,y} | cluster_type, priority, deadline_offset_s?, weight_kg? }`;
missing fields are filled from the generator's distributions. Ground coordinates in files are PRD
`{x, y}`; `y` maps onto the world's `z` axis.

Supported faults: `urgent_job_burst`, `close_zone` (by zone id, or a new circle/polygon), `radio_blackout` (switch a radio
dead zone on, or create a temporary circle/box/polygon), `pad_outage` / `depot_outage` (charging out of
service for a window), `weather_front` (wind ramps to new speed, direction and gusts), `storm_cell` (a closed,
optionally drifting circle with extra wind) and `altitude_cap` (a ceiling over the whole map or an area), `battery_drain`,
`kill_drone` (in-flight parcel re-ordered after the endurance timeout). `partition`, `kill_service`,
`link_loss` and `clock_drift` are parsed and logged as unsupported until the network model exists.

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
| `scenario/*` | YAML scenario loading, validation and defaults (PRD section 15). |
| `sim/Task`, `sim/TaskBoard` | PRD task schema; shared board with epoch-fenced claims, lease expiry (zombie-stop), commit, depot pickup arbitration (`PICKUP_GRANT` / `TASK_TAKEN`), sticky ownership after pickup, re-orders. |
| `sim/WorkloadGenerator` | Poisson arrivals, clustered demand, priority mix, deadline and weight distributions, scripted tasks, bursts. |
| `sim/Faults` | Scripted fault injector. |
| `sim/Battery` | Power model with wind, pessimistic estimator. |
| `sim/ObstacleManager` | Static spatial hash, moving obstacles, active/closable zones. |
| `sim/PathPlanner` | Windowed A* on lazily rasterised 250 m occupancy chunks per altitude layer; `computeAvoidance` = local reactive avoidance. |
| `sim/AgentCoordinator` | Radio bus, neighbour discovery, bid scoring (priority, distance, lateness, energy, pad contention) and claim consensus. |
| `sim/LocalAgentController` | Per-drone FSM implementing `AgentController` (lease renewal, zombie-stop, urgent re-auction, depot pickup, abort). |
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

## Known limits
Ground vehicles are decorative. The radio is an ideal disc (`network.loss` adds packet loss). Planning
is 2.5D (altitude layers). Partition policies, shard leases, gossip and the failure detector are not
implemented yet (fields exist in the task schema; see `docs/DECISIONS.md`).
