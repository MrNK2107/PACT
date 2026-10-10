import { useSyncExternalStore } from 'react';
import type { SimSnapshot } from '../sim/SimulationEngine';
import { engine } from './simContext';

/**
 * UI telemetry is sampled from the engine at ~5 Hz and published through one external store, so React
 * re-renders at a fixed low rate regardless of simulation speed or drone count. 3D rendering never
 * goes through React state: renderers read engine state directly inside useFrame.
 */
let latest: SimSnapshot = engine.snapshot();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function publish() {
  latest = engine.snapshot();
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) timer = setInterval(publish, 200);
  const off = engine.subscribe(publish);
  publish();
  return () => {
    listeners.delete(l);
    off();
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function useSimSnapshot(): SimSnapshot {
  return useSyncExternalStore(subscribe, () => latest);
}

/** Structural fleet version (changes only on add / remove / reset). */
export function useFleetVersion(): number {
  return useSyncExternalStore(
    (l) => engine.subscribe(l),
    () => engine.fleetVersion * 1000 + engine.resetEpoch,
  );
}
