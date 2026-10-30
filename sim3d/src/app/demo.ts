import { seekEngine } from './replay';
import { engine, map, scenario, world } from './simContext';
import { useUI, type Caption, type ToggleKey } from './uiStore';

/**
 * Scripted demo (TC-13, docs/05_evaluation_plan.md section 5.7). `?demo` plays the scenes below in order, reloading
 * the page for each scene's map / scenario / system; `?demo=<id>` starts at one scene and `&once` stops after it
 * (recordings: the page sets `window.__demoDone`). Scenes only use what a viewer could do by hand: seek, speed,
 * camera, layers, selection and captions. Every number in a caption comes from results/summary.md or
 * results/sweep/sweep.md.
 */

type Vec3 = [number, number, number];

interface SceneCtx {
  caption: (c: Caption | null) => void;
  shot: (position: Vec3, target: Vec3, seconds?: number) => void;
  layer: (k: ToggleKey, on: boolean) => void;
  follow: (id: string | null) => void;
  /** Wall-clock pause (s). */
  wait: (s: number) => Promise<void>;
  /** Plays until simulated time reaches `t` (s). */
  until: (t: number) => Promise<void>;
  seek: (t: number) => Promise<void>;
  /** Re-simulates forward to `t` without rendering in between, then keeps playing. */
  skip: (t: number) => Promise<void>;
  speed: (x: number) => void;
  play: () => void;
  depot: (i: number) => Vec3;
  /** Camera eye `dist` metres from `target`, from the south-east at `elev` degrees. */
  around: (target: Vec3, dist: number, elev?: number, azimuthDeg?: number) => Vec3;
  /** Like `around`, but from the far side of `target` as seen from the map centre, so the city fills the frame. */
  aroundOut: (target: Vec3, dist: number, elev?: number, turnDeg?: number) => Vec3;
  hud: (on: boolean) => void;
}

export interface DemoScene {
  id: string;
  map?: string;
  scenario: string;
  system?: string;
  run: (c: SceneCtx) => Promise<void>;
}

export const DEMO_SCENES: DemoScene[] = [
  {
    id: 'intro',
    scenario: 's0_healthy',
    async run(c) {
      const d = c.depot(0);
      c.shot(c.around([0, 0, 0], world.size * 0.75, 38, 45), [0, 0, 0], 0);
      await c.seek(40);
      c.speed(2);
      c.play();
      c.caption({ tag: 'PACT · simulation', title: 'A delivery fleet with no central controller', sub: 'Every drone runs the same logic and talks only to drones in radio range.' });
      c.shot(c.aroundOut(d, 650, 34, -20), d, 9);
      await c.wait(9);
      c.caption({ tag: 'How jobs are shared', title: 'Drones bid for jobs over the radio', sub: 'Score by priority, distance, deadline and energy. Broadcast a CLAIM; a lower bid backs off.' });
      c.layer('showComms', true);
      c.shot(c.aroundOut(d, 380, 30, 25), d, 8);
      await c.wait(9);
      c.caption({ tag: 'Shared state', title: 'Each drone keeps its own copy of the order board', sub: 'Copies merge by gossip (CRDT). Ownership is fenced by epochs and leases.' });
      const id = engine.agents[0]?.id ?? null;
      c.follow(id);
      await c.wait(9);
      c.follow(null);
      c.layer('showComms', false);
    },
  },
  {
    id: 'hub_central',
    scenario: 's1_hub_loss',
    system: 'central_hub_loss',
    async run(c) {
      await hubScene(c, [
        { tag: 'Baseline · central hub', title: 'One hub assigns every job', sub: 'Same map, same seed, same orders as PACT.' },
        { tag: 'Fault · t = 180 s', title: 'The hub dies', sub: 'Nothing assigns new jobs. On-time rate falls from 86.3% to 56.8%.' },
      ]);
    },
  },
  {
    id: 'hub_pact',
    scenario: 's1_hub_loss',
    system: 'pact',
    async run(c) {
      await hubScene(c, [
        { tag: 'PACT · same fault', title: 'The same hub dies at t = 180 s', sub: 'There is nothing central to lose.' },
        { tag: 'Result 1', title: 'PACT keeps delivering', sub: '86.3% on time after hub loss, the same as the healthy run. 0 loss of separation.' },
      ]);
    },
  },
  {
    id: 'partition',
    scenario: 'at03_split_brain_strict',
    async run(c) {
      c.layer('showP2P', true);
      c.hud(true);
      c.shot(c.around([0, 0, 0], world.size * 0.95, 48, 40), [0, 0, 0], 0);
      await c.seek(100);
      c.speed(2);
      c.play();
      c.caption({ tag: 'Fault · radio partition', title: 'The radio splits the fleet in two', sub: 'Colours show which drones and depots can still hear each other.' });
      await c.until(124);
      c.speed(8);
      c.caption({ tag: 'Partition policy', title: 'Each side keeps working, safely', sub: 'STRICT: a cut-off side only claims work it holds a shard lease for. The depot hands a parcel only to the newest epoch.' });
      await c.until(300);
      c.caption({ tag: 'Result 2', title: 'Zero double deliveries', sub: '240-run sweep with 5-minute splits: PACT 0 duplicates; a plain auction up to 17.8 per run.' });
      await c.until(425);
      c.speed(2);
      c.caption({ tag: 't = 420 s', title: 'Link restored: the copies merge and agree', sub: 'No reconciliation step and no duplicates to undo.' });
      await c.wait(7);
      c.layer('showP2P', false);
      c.hud(false);
    },
  },
  {
    id: 'failure',
    scenario: 'at06_drone_failure',
    async run(c) {
      await c.seek(146);
      c.follow('A01');
      c.hud(true);
      c.speed(1);
      c.play();
      c.caption({ tag: 'Fault · drone failure', title: 'A01 fails mid-delivery', sub: 'No distress call: it simply goes silent.' });
      await c.until(160);
      c.follow(null);
      c.speed(4);
      c.shot(c.around([0, 0, 0], world.size * 0.8, 45, 40), [0, 0, 0], 4);
      c.caption({ tag: 'Recovery', title: 'Peers report silence, the depot declares it failed', sub: 'Its lease expires, the job reopens at a higher epoch and one replacement is re-auctioned.' });
      await c.until(235);
      c.hud(false);
    },
  },
  {
    id: 'outro',
    scenario: 's_scripted_demo',
    async run(c) {
      c.shot(c.around([0, 0, 0], world.size * 0.7, 36, 20), [0, 0, 0], 0);
      await c.seek(120);
      c.speed(2);
      c.play();
      c.shot(c.around([0, 0, 0], world.size * 0.62, 30, 80), [0, 0, 0], 16);
      c.caption({ tag: 'Deterministic', title: 'Same seed, same log hash', sub: 'Every run can be replayed and verified event by event.' });
      await c.wait(8);
      c.caption({ tag: 'Next', title: 'Same protocol in ROS 2, Gazebo and PX4', sub: 'Simulation only today. Not flight-ready.' });
      await c.wait(8);
    },
  },
];

/** Hub loss at t = 180 s (s1_hub_loss), told the same way for the central baseline and for PACT. */
async function hubScene(c: SceneCtx, [before, after]: [Caption, Caption]): Promise<void> {
  const d = c.depot(0);
  c.hud(true);
  c.shot(c.aroundOut(d, 950, 38, -25), d, 0);
  await c.seek(150);
  c.speed(2);
  c.play();
  c.caption(before);
  await c.until(180);
  c.caption(after);
  c.speed(8);
  c.shot(c.aroundOut(d, 1300, 46, 20), [d[0] * 0.6, 0, d[2] * 0.6], 14);
  await c.until(330);
  // jump to the end of the 900 s benchmark window, where the gap is the bench result
  c.caption({ tag: 'Fast-forward', title: 'Nine minutes later', sub: 'The same 900 s window the benchmark scores.' });
  await c.skip(830);
  c.speed(4);
  await c.until(900);
  await c.wait(3);
  c.hud(false);
}

function context(): SceneCtx {
  const ui = () => useUI.getState();
  const sleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));
  return {
    caption: (cap) => ui().setCaption(cap),
    shot: (position, target, seconds = 4) => ui().playShot({ position, target, seconds }),
    layer: (k, on) => {
      if (ui()[k] !== on) ui().toggle(k);
    },
    follow: (id) => {
      ui().select(id);
      if (id) ui().focusSelection();
    },
    wait: sleep,
    until: async (t) => {
      if (engine.status !== 'running') engine.status === 'idle' ? engine.start() : engine.resume();
      while (engine.time < t) await sleep(0.1);
    },
    seek: (t) => seekEngine(engine, t),
    skip: async (t) => {
      await seekEngine(engine, t);
      engine.resume();
    },
    speed: (x) => engine.setSpeed(x),
    play: () => (engine.status === 'idle' ? engine.start() : engine.resume()),
    depot: (i) => {
      const d = world.depots[Math.min(i, world.depots.length - 1)];
      return [d.pos.x, d.pos.y, d.pos.z];
    },
    hud: (on) => ui().setHud(on),
    aroundOut: (target, dist, elev = 35, turn = 0) => {
      const az = (Math.atan2(target[2], target[0]) * 180) / Math.PI + turn;
      const e = (elev * Math.PI) / 180;
      const a = (az * Math.PI) / 180;
      return [target[0] + dist * Math.cos(e) * Math.cos(a), target[1] + dist * Math.sin(e) + world.terrain.maxY, target[2] + dist * Math.cos(e) * Math.sin(a)];
    },
    around: (target, dist, elev = 35, az = 45) => {
      const e = (elev * Math.PI) / 180;
      const a = (az * Math.PI) / 180;
      return [target[0] + dist * Math.cos(e) * Math.cos(a), target[1] + dist * Math.sin(e) + world.terrain.maxY, target[2] + dist * Math.cos(e) * Math.sin(a)];
    },
  };
}

function sceneUrl(s: DemoScene, keep: URLSearchParams): string {
  const u = new URL(location.href);
  u.search = '';
  if (s.map) u.searchParams.set('map', s.map);
  u.searchParams.set('scenario', s.scenario);
  if (s.system) u.searchParams.set('system', s.system);
  u.searchParams.set('demo', s.id);
  u.searchParams.set('film', '');
  for (const k of ['once', 'nocaption']) if (keep.has(k)) u.searchParams.set(k, '');
  return u.toString();
}

/** Starts the demo when the URL asks for it. */
export function maybeRunDemo(): void {
  if (typeof location === 'undefined') return;
  const params = new URLSearchParams(location.search);
  if (!params.has('demo')) return;
  const want = params.get('demo') || DEMO_SCENES[0].id;
  const i = Math.max(0, DEMO_SCENES.findIndex((s) => s.id === want));
  const scene = DEMO_SCENES[i];
  // each scene needs its own map / scenario / system (module singletons), so a mismatch means: load the scene's page
  const sysOk = (scene.system ?? 'pact') === engine.system;
  if (scene.scenario !== scenario.name || (scene.map && scene.map !== map.id) || !sysOk || params.get('demo') !== scene.id) {
    location.replace(sceneUrl(scene, params));
    return;
  }
  const w = window as unknown as { __demoScene?: string; __demoDone?: boolean };
  w.__demoScene = scene.id;
  w.__demoDone = false;
  useUI.getState().setFilm(true);
  const ctx = context();
  if (params.has('nocaption')) ctx.caption = () => undefined;
  // let the first frame render before the scene starts moving
  setTimeout(async () => {
    await scene.run(ctx);
    ctx.caption(null);
    w.__demoDone = true;
    const next = DEMO_SCENES[i + 1];
    if (next && !params.has('once')) location.replace(sceneUrl(next, params));
    else engine.pause();
  }, 600);
}
