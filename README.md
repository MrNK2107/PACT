# PACT: Partition-Aware Coordination for Transport

**KPIT Sparkle 2027 · Decentralized Multi-Agent Coordination for Autonomous Logistics · Team PANGnovates, Saveetha Engineering College**

A fleet of delivery drones that shares out jobs, charges at scarce pads, keeps separation and carries on through faults (hub loss, drone loss, radio dead zones, partitions, storms, pad outages) **with no central controller**, and never delivers a parcel twice when the radio splits the fleet.

The same protocol is implemented twice:

| Simulator | Folder | Stack | Use it for |
|---|---|---|---|
| **sim3d** | `sim3d/` | TypeScript, Three.js (React Three Fiber); runs in the browser and headless in Node | Fast deterministic experiments: 8 city maps, 35 fault scenarios, the benchmark against four baselines, the partition-policy sweep, the 3D viewer, the replay viewer and the scripted demo. |
| **AeroPACT** | `aeropact/` | ROS 2 Jazzy (C++ lifecycle components), Gazebo Harmonic, PX4 v1.16 SITL | The protocol as robotics software: one component container per drone, quadrotor physics in Gazebo, PX4 autopilots in the loop, an authenticated mesh radio transport. |

> **Simulation only.** Neither simulator is a flight-readiness model, and nothing here has flown. sim3d uses simplified kinematics and an accelerated battery model; AeroPACT runs real autopilot software, but only in simulation.

![The sim3d viewer: the coastal_metro map with telemetry, the order board and the fleet list](docs/img/sim3d.png)

## For reviewers

| Start here | |
|---|---|
| **Demo video** | [Google Drive](https://drive.google.com/file/d/1qlPbHO_VTEOLMpG-KsM2Ratiawf_xRO6/view?usp=sharing) (about 3 minutes) |
| **Reviewer documents** | [`docs/submission/`](docs/submission/), also in the [Google Drive folder](https://drive.google.com/drive/folders/1-udBn0FYfy1-YIIxnf0yAcD5kpeAF4en?usp=sharing) |

| Document | What it answers |
|---|---|
| [`PACT_01_Project_Summary.docx`](docs/submission/PACT_01_Project_Summary.docx) | What PACT is, why it matters, what is new, the headline results, status and roadmap. Read this first. |
| [`PACT_02_Technical_Design_Document.docx`](docs/submission/PACT_02_Technical_Design_Document.docx) | Architecture, task allocation, fenced ownership, shared state, partition policies, safety, energy, failure detection, invariants, messages, key design decisions, risks. |
| [`PACT_03_Evaluation_and_Results_Report.docx`](docs/submission/PACT_03_Evaluation_and_Results_Report.docx) | Method, baselines, metrics, every benchmark and sweep result with confidence intervals, tests, limitations, and where PACT does not win. |
| [`PACT_04_Setup_and_Reproduction_Guide.docx`](docs/submission/PACT_04_Setup_and_Reproduction_Guide.docx) | Install, run the viewer, run the tests, and reproduce every published number on Windows, macOS or Linux. |

## Headline results (sim3d)

| | PACT | Baseline |
|---|---|---|
| Hub killed at t = 180 s: on-time rate | **86.3 %** (no drop) | central fleet 86.3 % → **56.8 %** |
| Deliveries per run after hub loss | **20.0** | central fleet 20.2 → 7.6 |
| Duplicate deliveries, 240 runs with 5-minute radio splits | **0** | plain auction: up to 17.8 per run |
| Failed carrier: kill → replacement claimed (median) | **9.9 s** | 61.7–67.9 s |
| Automated tests | 391 sim3d (1 skipped), 75 / 75 scenario acceptance; AeroPACT 692 (92 skipped), acceptance 9 / 9, PX4 SITL 4 / 4 | |

Sources: `results/summary.md`, `results/sweep/sweep.md`, `results/recovery.json`. The evaluation report lists the caveats: the hub-loss acceptance check (AT-05) is recorded as FAIL at 900 s because the central baseline drops 34.1 % against a > 40 % gate (PACT's side passes), and two sweep runs (STRICT policy, canyon map) logged one loss of separation each.

## Quick start: sim3d (browser)

Node 18 or newer.

```bash
cd sim3d
npm install
npm run dev          # http://localhost:5173
```

URL options: `?map=<id>&scenario=<name>` picks a world and scenario; `?system=<pact|central_full|central_hub_loss|greedy_nearest|cbba_plain>` runs a baseline instead of PACT; `?autostart` starts the run; `?replay` opens the replay viewer; `?demo` plays the scripted demo; `?film` hides the panels. To watch the central hub fail while PACT carries on, open `/?scenario=s1_hub_loss&system=central_hub_loss&autostart` next to `/?scenario=s1_hub_loss&autostart`.

Check determinism in about 10 seconds: two runs of the same scenario and seed give the same event-log hash as the published `results/results.csv`:

```bash
npm run bench -- --scenarios=s1_hub_loss --systems=pact,central_hub_loss --seeds=1 --recovery=0 --out=../tmp_check
```

## Quick start: AeroPACT (Gazebo)

Ubuntu 24.04 (native or WSL2) with ROS 2 Jazzy desktop and `ros-jazzy-ros-gz`, or the image in `aeropact/docker/`.

```bash
make gz-build        # colcon build into ~/.cache/aeropact (out of tree)
make gz-test         # unit, property and lint suites
make gz-demo         # Gazebo + RViz: hub loss, partition, drone failure in flight
make gz-scenarios    # acceptance AT-03..AT-10 on the full ROS 2 graph (~35 min)
# PX4 autopilots in the loop (fetches and builds PX4 v1.16 SITL once, ~25 min):
make -C aeropact px4-toolchain && make gz-build && make gz-scenarios-px4
```

`aeropact/README.md` covers the packages, launch arguments, deployment launches and its benchmark.

## Commands

| `make` target | npm equivalent (in `sim3d/`) | What it does |
|---|---|---|
| `make test` | `npm test` | Unit and property tests (about 1 min). |
| `make scenarios` | `npm run scenarios` | Scenario acceptance suite: every scenario against its tier gate, the invariants, determinism and the P2P acceptance checks (about 17 min; `npm run scenarios -- suite` or `-- acceptance` runs one part). |
| `make lint` | `npm run typecheck` | `tsc --noEmit`. |
| `make bench` | `npm run bench -- --seeds=5 --window=900` | Scenario × system × seed benchmark; writes `results/` (about 2 min). |
| `make sweep` | `npm run sweep -- --seeds=30 --window=900` | Partition-policy sweep (240 runs); writes `results/sweep/` (about 10 min). |
| `make plots` | `npm run plots` | SVG plots in `results/plots/`. |
| `make demo` | `npm run dev -- --open "/?demo"` | The scripted demo in the live viewer (about 5 min). |

On Windows without GNU Make, use the npm column from `sim3d/`. The AeroPACT `gz-*` targets run inside Ubuntu 24.04.

## Repository

| Path | What it is |
|---|---|
| `sim3d/` | TypeScript simulator and 3D viewer (Vite, React 18, React Three Fiber, vitest). `sim3d/README.md` covers the world generator, scenario schema, tiers and module layout. |
| `sim3d/maps/`, `sim3d/scenarios/` | 8 maps (2 to 12 km) and 35 YAML scenarios. Scenario files are the only way to change behaviour in experiments. |
| `aeropact/` | ROS 2 / Gazebo / PX4 workspace (12 colcon packages) with its own README and results. |
| `results/` | Published benchmark, sweep, recovery and plot outputs. |
| `docs/submission/` | The four reviewer documents. |
| `docs/slides/`, `docs/img/` | Pitch-deck slides as HTML and their 4K renders. |
| `video/` | Demo video pipeline: narration script, recorder, editor. |
| `.github/workflows/` | CI: `sim3d.yml` (type check, tests) and `aeropact.yml` (ROS-free core, Python, ROS 2 build and linters). |

## How coordination works

- **Allocation, no controller:** each idle drone scores the open jobs (priority, distance, lateness, energy, pad demand) and may bid only if its payload fits and its battery covers the job, a charging pad and a reserve. It broadcasts a `CLAIM` over a range-limited radio and backs off if a neighbour outbids it.
- **Fenced ownership:** every claim carries an epoch (a counter that rises each time a job is re-assigned) and a lease the owner renews with heartbeats. When a lease lapses before pickup, the old owner stops first (zombie-stop) and only then does the depot re-open the job at a higher epoch. A depot hands a parcel only to the highest valid epoch, so no parcel is delivered twice.
- **Shared state:** every drone and depot keeps its own copy of the order board as a CRDT (copies merge in any order and still agree), synced by gossip. Depots also gossip over a wired or cellular backhaul that drones never use.
- **Partition policy:** a drone cut off from the fleet follows one fixed rule, STRICT, QUORUM or OPTIMISTIC_BOUNDED, on what new work it may claim.
- **Safety:** drones share intent in their heartbeats and resolve conflicts with one give-way order that every drone evaluates the same way; the safety code never depends on the auction code.
- **Failure detection:** a drone is declared failed only on evidence: peers that expected to hear it report silence.
- **Determinism:** fixed 20 Hz steps, seeded randomness, ordered iteration; the same scenario and seed always give the same event-log hash.

## License

Apache-2.0 for AeroPACT (`aeropact/LICENSE`).
