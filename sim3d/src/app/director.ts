import { deliveryCounts, seekEngine } from './replay';
import { engine, map, scenario, world } from './simContext';
import { useUI, type Caption, type ToggleKey } from './uiStore';

/**
 * Scripting hook for recordings and automated demos: `window.pact` drives the viewer the way a person would (camera
 * shots, captions, layers, selection, speed, seeking). It only calls public engine and UI-store methods, so a script
 * cannot do anything the toolbar could not.
 */
export interface Director {
  readonly map: string;
  readonly scenario: string;
  readonly system: string;
  time(): number;
  start(): void;
  pause(): void;
  resume(): void;
  speed(x: number): void;
  seek(t: number): Promise<void>;
  /** Advance the run by `seconds` of simulated time, without rendering in between (fast-forward). */
  skip(seconds: number): Promise<void>;
  shot(position: [number, number, number], target: [number, number, number], seconds?: number): void;
  caption(c: Caption | null): void;
  layer(key: ToggleKey, on: boolean): void;
  follow(id: string | null): void;
  film(on: boolean): void;
  replay(on: boolean): void;
  depots(): { id: string; x: number; y: number; z: number }[];
  drones(): { id: string; x: number; y: number; z: number; state: string }[];
  counts(): { delivered: number; duplicates: number; events: number };
  /** Film-mode scoreboard: system, clock, deliveries (since the first fault) and duplicates. */
  hud(on: boolean): void;
  hash(): string;
  /** The structured event log so far (JSONL), as the replay bar's Save log writes it. */
  log(): string;
}

export function installDirector(): void {
  if (typeof window === 'undefined') return;
  const ui = () => useUI.getState();
  const d: Director = {
    map: map.id,
    scenario: scenario.name,
    system: engine.system,
    time: () => engine.time,
    start: () => engine.start(),
    pause: () => engine.pause(),
    resume: () => engine.resume(),
    speed: (x) => engine.setSpeed(x),
    seek: (t) => seekEngine(engine, t),
    skip: async (seconds) => {
      const running = engine.status === 'running';
      await seekEngine(engine, engine.time + seconds);
      if (running) engine.resume();
    },
    shot: (position, target, seconds = 3) => ui().playShot({ position, target, seconds }),
    caption: (c) => ui().setCaption(c),
    layer: (key, on) => {
      if (ui()[key] !== on) ui().toggle(key);
    },
    follow: (id) => {
      ui().select(id);
      if (id) ui().focusSelection();
    },
    film: (on) => ui().setFilm(on),
    replay: (on) => ui().setReplay(on),
    depots: () => world.depots.map((x) => ({ id: x.id, x: x.pos.x, y: x.pos.y, z: x.pos.z })),
    drones: () => engine.agents.map((a) => ({ id: a.id, x: a.body.pos.x, y: a.body.pos.y, z: a.body.pos.z, state: String(a.controller.phase) })),
    counts: () => {
      const c = deliveryCounts(engine.events);
      return { delivered: c.delivered, duplicates: c.duplicates, events: engine.events.length };
    },
    hud: (on) => ui().setHud(on),
    hash: () => engine.eventHash(),
    log: () => engine.exportEventsJsonl(),
  };
  (window as unknown as { pact: Director }).pact = d;
}
