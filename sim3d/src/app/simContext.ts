import { resolveSelection } from '../scenario/registry';
import { worldConfigFrom } from '../scenario/load';
import { SimulationEngine } from '../sim/SimulationEngine';
import { SYSTEM_IDS, type SystemId } from '../sim/systems';
import { createWorld } from '../world/buildWorld';

/**
 * One session = one map + one scenario (+ optional system under test), chosen with `?map=<id>&scenario=<name>&system=<id>` (see maps/*.yaml and
 * scenarios/<map>/*.yaml). World and engine are module singletons because the render loop reads them
 * inside useFrame closures, so switching map or scenario reloads the page.
 */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const selection = resolveSelection(params?.get('map'), params?.get('scenario'));
export const map = selection.map;
// `?system=<id>` runs a baseline instead of PACT (demo: s1_hub_loss with central_hub_loss vs pact)
const sysParam = params?.get('system') as SystemId | null | undefined;
export const scenario = sysParam && SYSTEM_IDS.includes(sysParam) ? { ...selection.scenario, system: sysParam } : selection.scenario;
export const world = createWorld(worldConfigFrom(scenario));
export const engine = new SimulationEngine(world, scenario);
// `?autostart` starts the run on load (demos, screenshots)
if (params?.has('autostart')) engine.start();
