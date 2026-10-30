import { advance } from '@react-three/fiber';

/**
 * Offline rendering for recordings (`?offline`): the render loop does not run on its own; a recorder calls
 * `window.pactRender.step(dt)` once per video frame, which advances a virtual clock by exactly `dt`, wakes any demo
 * step waiting on that clock, and renders one frame. The video is then smooth at any frame rate however long each
 * frame takes to draw. The simulation itself is driven from the render loop (SimDriver), so it follows the same
 * clock. Live viewing is unaffected: without `?offline` the canvas uses the normal animation loop.
 */
export const offline = typeof location !== 'undefined' && new URLSearchParams(location.search).has('offline');

let now = 0;
let busy = 0;
const timers: { at: number; resolve: () => void }[] = [];

/** Virtual seconds since the page loaded (offline), else wall-clock seconds. */
export function clockNow(): number {
  return offline ? now : performance.now() / 1000;
}

/** Sleep on the recording clock (offline) or the wall clock. */
export function sleep(seconds: number): Promise<void> {
  if (!offline) return new Promise((r) => setTimeout(r, seconds * 1000));
  return new Promise((resolve) => {
    timers.push({ at: now + seconds, resolve });
    timers.sort((a, b) => a.at - b.at);
  });
}

/** Marks work that should not be filmed (seeking re-simulates; frames would just repeat). */
export async function whileBusy<T>(work: () => Promise<T>): Promise<T> {
  busy++;
  try {
    return await work();
  } finally {
    busy--;
  }
}

export interface OfflineRender {
  /** Advance the recording clock by `dt` seconds and render one frame. `busy`: do not record this frame. */
  step(dt: number): Promise<{ t: number; busy: boolean }>;
}

export function installOffline(): void {
  if (!offline || typeof window === 'undefined') return;
  const r: OfflineRender = {
    async step(dt) {
      if (busy > 0) {
        // a seek is re-simulating on the wall clock: hold the recording clock until it is done
        await new Promise((res) => setTimeout(res, 20));
        return { t: now, busy: true };
      }
      now += dt;
      while (timers.length && timers[0].at <= now + 1e-9) timers.shift()!.resolve();
      // let woken demo steps run (they may set captions, shots, speed) before the frame is drawn
      await new Promise((res) => setTimeout(res, 0));
      advance(now);
      return { t: now, busy: busy > 0 };
    },
  };
  (window as unknown as { pactRender: OfflineRender }).pactRender = r;
}
