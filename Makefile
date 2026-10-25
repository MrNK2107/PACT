# Project commands. The simulator lives in sim3d (TypeScript), so `lint` is the type check.
# `bench` runs scenario x system x seed (TC-11 baselines, TC-12 runner) and writes results/; `demo` opens the
# scripted-demo scenario in the live viewer (a replay viewer does not exist yet).
# bench options: make bench SEEDS=30 WINDOW=900 SCENARIOS=s0_healthy,s1_hub_loss SYSTEMS=pact,central_hub_loss
# `sweep` is the AT-12 policy sweep (results/sweep/), `plots` renders results/plots/*.svg from bench + sweep output.
# sweep options: make sweep SWEEP_SEEDS=30 SWEEP_WINDOW=900 (scenarios / systems via SWEEP_SCENARIOS / SWEEP_SYSTEMS)

.PHONY: test scenarios lint bench sweep plots demo

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
