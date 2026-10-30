import { computeNetView, lastConverged, type NetView } from './netGraph';
import { engine } from './simContext';

/**
 * Memoised radio-graph view shared by the 3D overlays and the panels. The O(n^2) link scan runs at most every
 * `REFRESH_MS` of wall time, and only when the simulation moved (time, fleet or reset changed) since the last one.
 * Wall time here paces the viewer only; the simulation never reads it.
 */
const REFRESH_MS = 250;

let cache: NetView | null = null;
let cacheKey = '';
let cacheAt = -Infinity;

export function currentNetView(): NetView {
  const key = `${engine.resetEpoch}|${engine.fleetVersion}|${engine.time}`;
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const stale = !cache || cache.epoch !== engine.resetEpoch || (key !== cacheKey && now - cacheAt >= REFRESH_MS);
  if (stale) {
    cache = computeNetView(engine);
    cacheKey = key;
    cacheAt = now;
  }
  return cache!;
}

// latest replica_converged: incremental scan of the event log (reset with the engine)
let convEpoch = -1;
let convScanned = 0;
let conv: { t: number; elapsed: number } | null = null;

export function latestConverged(): { t: number; elapsed: number } | null {
  if (convEpoch !== engine.resetEpoch || engine.events.length < convScanned) {
    convEpoch = engine.resetEpoch;
    convScanned = 0;
    conv = null;
  }
  const n = engine.events.length;
  if (n > convScanned) {
    conv = lastConverged(engine, convScanned) ?? conv;
    convScanned = n;
  }
  return conv;
}
