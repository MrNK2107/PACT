import { create } from 'zustand';

export interface Selection {
  id: string;
}

/** A scripted camera move (film mode / `window.pact.shot`): eye and target in world metres, eased over `seconds`. */
export interface CameraShot {
  position: [number, number, number];
  target: [number, number, number];
  seconds: number;
  nonce: number;
}

/** Lower-third caption shown in film mode. */
export interface Caption {
  title: string;
  sub?: string;
  /** Small uppercase tag above the title, e.g. "RESULT 1". */
  tag?: string;
}

const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;

export interface UIState {
  showBuildings: boolean;
  showGrid: boolean;
  showRoutes: boolean;
  showWaypoints: boolean;
  showNoFly: boolean;
  showObstacles: boolean;
  showComms: boolean;
  showRadio: boolean;
  showLabels: boolean;
  showWind: boolean;
  showShards: boolean;
  /** P2P view: radio components (halos, links, depot masts), ledger-owner tints on task drops. */
  showP2P: boolean;
  selection: Selection | null;
  /** Replay bar (TC-13): timeline, seek, load / verify / save the event log. `?replay` opens it. */
  showReplay: boolean;
  /** Film mode: full-bleed 3D view without panels, for recordings. `?film`. */
  film: boolean;
  caption: Caption | null;
  /** Film-mode scoreboard. */
  hud: boolean;
  shot: CameraShot | null;
  cameraResetNonce: number;
  focusNonce: number;
  toggle: (k: ToggleKey) => void;
  select: (id: string | null) => void;
  resetCamera: () => void;
  focusSelection: () => void;
  setReplay: (on: boolean) => void;
  setFilm: (on: boolean) => void;
  setCaption: (c: Caption | null) => void;
  setHud: (on: boolean) => void;
  playShot: (s: Omit<CameraShot, 'nonce'>) => void;
}

export type ToggleKey = 'showBuildings' | 'showGrid' | 'showRoutes' | 'showWaypoints' | 'showNoFly' | 'showObstacles' | 'showComms' | 'showRadio' | 'showLabels' | 'showWind' | 'showShards' | 'showP2P';

export const useUI = create<UIState>((set) => ({
  showBuildings: true,
  showGrid: false,
  showRoutes: true,
  showWaypoints: true,
  showNoFly: true,
  showObstacles: false,
  showComms: false,
  showRadio: true,
  showLabels: true,
  showWind: false,
  showShards: false,
  showP2P: false,
  selection: null,
  showReplay: !!params?.has('replay'),
  film: !!params?.has('film'),
  caption: null,
  hud: false,
  shot: null,
  cameraResetNonce: 0,
  focusNonce: 0,
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<UIState>),
  select: (id) => set({ selection: id ? { id } : null }),
  resetCamera: () => set((s) => ({ cameraResetNonce: s.cameraResetNonce + 1 })),
  focusSelection: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
  setReplay: (on) => set({ showReplay: on }),
  setFilm: (on) => set({ film: on }),
  setCaption: (c) => set({ caption: c }),
  setHud: (on) => set({ hud: on }),
  playShot: (shot) => set((s) => ({ shot: { ...shot, nonce: (s.shot?.nonce ?? 0) + 1 } })),
}));
