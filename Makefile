# Project commands. The simulator lives in sim3d (TypeScript), so `lint` is the type check.
# `bench` and `demo` need pieces that do not exist yet (policy baselines, replay viewer); `bench` fails loudly
# instead of pretending, and `demo` opens the scripted-demo scenario in the live viewer.

.PHONY: test scenarios lint bench demo

test:
	cd sim3d && npm test

scenarios:
	cd sim3d && npm run scenarios

lint:
	cd sim3d && npm run typecheck

bench:
	@echo "bench: not implemented. It needs the policy and baseline implementations (TC-11, TC-12) and a results writer."
	@exit 1

demo:
	cd sim3d && npm run dev -- --open "/?scenario=s_scripted_demo&autostart"
