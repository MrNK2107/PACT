import { getScenario } from '../scenario/registry';
import { worldConfigFrom } from '../scenario/load';
import { SimulationEngine } from '../sim/SimulationEngine';
import { createWorld } from '../world/buildWorld';

/**
 * One session = one scenario. The scenario is chosen with `?scenario=<name>` (see scenarios/*.yaml);
 * world and engine are module singletons because the render loop reads them inside useFrame closures,
 * so switching scenario reloads the page.
 */
const requested = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('scenario') : null;
export const scenario = getScenario(requested);
export const world = createWorld(worldConfigFrom(scenario));
export const engine = new SimulationEngine(world, scenario);
