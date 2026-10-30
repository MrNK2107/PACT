# Project commands. Two simulators share this repo:
#   sim3d/     TypeScript simulator + 3D viewer (Three.js). The unprefixed targets below; `lint` is the type check.
#   aeropact/  ROS 2 Jazzy + Gazebo Harmonic + PX4 SITL workspace. The `gz-*` targets, run inside Ubuntu 24.04
#              (native, WSL2 or aeropact/docker); they forward to aeropact/Makefile, see aeropact/README.md.
# `bench` runs scenario x system x seed (TC-11 baselines, TC-12 runner) and writes results/; `demo` opens the
# scripted-demo scenario in the live viewer.
# bench options: make bench SEEDS=30 WINDOW=900 SCENARIOS=s0_healthy,s1_hub_loss SYSTEMS=pact,central_hub_loss
# `sweep` is the AT-12 policy sweep (results/sweep/), `plots` renders results/plots/*.svg from bench + sweep output.
# sweep options: make sweep SWEEP_SEEDS=30 SWEEP_WINDOW=900 (scenarios / systems via SWEEP_SCENARIOS / SWEEP_SYSTEMS)

.PHONY: test scenarios lint bench sweep plots demo gz-build gz-test gz-scenarios gz-scenarios-px4 gz-demo gz-bench test-all

test:
	cd sim3d && npm test

scenarios:
	cd sim3d && npm run scenarios

lint:
	cd sim3d && npm run typecheck

SEEDS ?= 5
WINDOW ?= 900

bench:
	cd sim3d && npm run bench -- --seeds=$(SEEDS) --window=$(WINDOW) $(if $(SCENARIOS),--scenarios=$(SCENARIOS)) $(if $(SYSTEMS),--systems=$(SYSTEMS))

SWEEP_SEEDS ?= 30
SWEEP_WINDOW ?= 900

sweep:
	cd sim3d && npm run sweep -- --seeds=$(SWEEP_SEEDS) --window=$(SWEEP_WINDOW)

plots:
	cd sim3d && npm run plots

demo:
	cd sim3d && npm run dev -- --open "/?scenario=s_scripted_demo&autostart"

# ---- AeroPACT (ROS 2 + Gazebo + PX4), inside Ubuntu 24.04 ----
gz-build:
	$(MAKE) -C aeropact build

gz-test:
	$(MAKE) -C aeropact test

gz-scenarios:
	$(MAKE) -C aeropact scenarios

gz-scenarios-px4:
	$(MAKE) -C aeropact scenarios-px4

gz-demo:
	$(MAKE) -C aeropact demo

gz-bench:
	$(MAKE) -C aeropact bench

# Both stacks' unit + property suites (needs Node and ROS 2 on the same machine, e.g. WSL2).
test-all: test gz-test
