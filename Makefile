# AeroPACT developer entry points. Run inside Ubuntu 24.04 (native, WSL2 or the Docker image).
#
# Build artifacts live outside the source tree (default ~/.cache/aeropact) so a checkout on a
# Windows drive mounted into WSL stays fast and clean. Parallelism is capped so a C++ build fits
# in ~6 GB of RAM; raise JOBS on bigger machines.

SHELL        := /bin/bash
ROS_DISTRO   ?= jazzy
WS           := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BUILD_ROOT   ?= $(HOME)/.cache/aeropact
JOBS         ?= 3
WORKERS      ?= 2
BUILD_TYPE   ?= RelWithDebInfo
VENV         ?= $(HOME)/.cache/aeropact/venv
SCENARIO     ?= hub_loss_partition
SEEDS        ?= 3
PACKAGES     ?=

ROS_SETUP    := source /opt/ros/$(ROS_DISTRO)/setup.bash
WS_SETUP     := $(ROS_SETUP) && source $(BUILD_ROOT)/install/setup.bash
COLCON_PATHS := --base-paths $(WS)/src --build-base $(BUILD_ROOT)/build --install-base $(BUILD_ROOT)/install
COLCON_LOG   := --log-base $(BUILD_ROOT)/log
SELECT       := $(if $(PACKAGES),--packages-up-to $(PACKAGES),)

export MAKEFLAGS_CHILD := -j$(JOBS)

.PHONY: help setup build test test-unit test-py test-core scenarios lint format bench demo sim clean plots

help:
	@echo "make setup      - create the Python tool venv (hypothesis, ruff, mypy) in $(VENV)"
	@echo "make build      - colcon build into $(BUILD_ROOT) (PACKAGES=... to limit)"
	@echo "make test       - unit + property tests (gtest, pytest) and ament linters"
	@echo "make test-py    - ROS-free Python tests + hypothesis properties (any OS, plain Python)"
	@echo "make test-core  - ROS-free C++ core build + gtest + hypothesis on the real CRDT merge"
	@echo "make plots      - regenerate docs/img/ figures from results/ (needs matplotlib)"
	@echo "make scenarios  - acceptance scenarios AT-xx on the kinematic SIL backend"
	@echo "make bench      - policy x baseline x seeds sweep, writes results/"
	@echo "make demo       - Gazebo demo: hub loss + partition with RViz"
	@echo "make lint       - ament linters + ruff + mypy"
	@echo "make format     - apply uncrustify and ruff formatting"

setup:
	python3 -m venv --system-site-packages $(VENV)
	$(VENV)/bin/pip install --quiet --upgrade pip
	$(VENV)/bin/pip install --quiet hypothesis==6.112.1 ruff==0.6.9 mypy==1.11.2 types-PyYAML

build:
	@mkdir -p $(BUILD_ROOT)
	$(ROS_SETUP) && MAKEFLAGS=-j$(JOBS) colcon $(COLCON_LOG) build $(COLCON_PATHS) $(SELECT) \
	  --parallel-workers $(WORKERS) --symlink-install \
	  --cmake-args -DCMAKE_BUILD_TYPE=$(BUILD_TYPE) -DCMAKE_EXPORT_COMPILE_COMMANDS=ON

test-unit: build
	$(WS_SETUP) && colcon $(COLCON_LOG) test $(COLCON_PATHS) $(SELECT) \
	  --parallel-workers $(WORKERS) --ctest-args -LE scenario --pytest-args -m "not scenario"
	$(WS_SETUP) && colcon $(COLCON_LOG) test-result --test-result-base $(BUILD_ROOT)/build --verbose

test: test-unit

# ---- ROS-free targets (also what .github/workflows/ci.yml runs) ----
PYTHON       ?= python3
CORE_BUILD   ?= $(WS)/build-core

test-py:
	PYTHONPATH=$(WS)/src/aeropact_eval $(PYTHON) -m pytest -q -p no:cacheprovider --rootdir=$(WS) 	  $(WS)/tests $(WS)/src/aeropact_eval/test/test_metrics.py $(WS)/src/aeropact_sim/test/test_world_generator.py

test-core:
	cmake -S $(WS)/ci/core -B $(CORE_BUILD) -DCMAKE_BUILD_TYPE=RelWithDebInfo
	cmake --build $(CORE_BUILD) -j$(JOBS)
	ctest --test-dir $(CORE_BUILD) --output-on-failure
	AEROPACT_MERGE_ORACLE=$(CORE_BUILD)/merge_oracle $(PYTHON) -m pytest -q -p no:cacheprovider 	  $(WS)/tests/test_crdt_merge_hypothesis.py

plots:
	$(PYTHON) $(WS)/tools/plot_results.py --results $(WS)/results --out $(WS)/docs/img

scenarios: build
	$(WS_SETUP) && colcon $(COLCON_LOG) test $(COLCON_PATHS) --packages-select aeropact_bringup \
	  --parallel-workers 1 --ctest-args -L scenario --output-on-failure
	$(WS_SETUP) && colcon $(COLCON_LOG) test-result --test-result-base $(BUILD_ROOT)/build/aeropact_bringup --verbose

lint:
	$(WS_SETUP) && colcon $(COLCON_LOG) test $(COLCON_PATHS) --ctest-args -L linter
	$(WS_SETUP) && colcon $(COLCON_LOG) test-result --test-result-base $(BUILD_ROOT)/build
	@if [ -x $(VENV)/bin/ruff ]; then $(VENV)/bin/ruff check $(WS)/src $(WS)/tools; \
	  else echo "ruff not installed: run 'make setup'"; fi
	@if [ -x $(VENV)/bin/mypy ]; then $(VENV)/bin/mypy --config-file $(WS)/mypy.ini $(WS)/src/aeropact_eval/aeropact_eval; \
	  else echo "mypy not installed: run 'make setup'"; fi

format:
	$(ROS_SETUP) && find $(WS)/src -name '*.cpp' -o -name '*.hpp' | xargs ament_uncrustify --reformat
	@if [ -x $(VENV)/bin/ruff ]; then $(VENV)/bin/ruff format $(WS)/src $(WS)/tools; fi

bench: build
	$(WS_SETUP) && ros2 run aeropact_eval bench --matrix $(WS)/src/aeropact_bringup/config/bench_matrix.yaml --seeds $(SEEDS) --out $(WS)/results

demo: build
	$(WS_SETUP) && ros2 launch aeropact_bringup demo.launch.py

sim: build
	$(WS_SETUP) && ros2 launch aeropact_bringup scenario.launch.py scenario:=$(SCENARIO) gui:=true

clean:
	rm -rf $(BUILD_ROOT)/build $(BUILD_ROOT)/install $(BUILD_ROOT)/log
