import { resolveSelection } from '../scenario/registry';
import { worldConfigFrom } from '../scenario/load';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';

/**
 * One session = one map + one scenario, chosen with `?map=<id>&scenario=<name>` (see maps/*.yaml and
 * scenarios/<map>/*.yaml). World and engine are module singletons because the render loop reads them
 * inside useFrame closures, so switching map or scenario reloads the page.
 */
const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const selection = resolveSelection(params?.get('map'), params?.get('scenario'));
export const map = selection.map;
export const scenario = selection.scenario;
export const world = createWorld(worldConfigFrom(scenario));
export const engine = new SimulationEngine(world, scenario);
// `?autostart` starts the run on load (demos, screenshots)
if (params?.has('autostart')) engine.start();
