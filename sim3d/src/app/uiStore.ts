import { create } from 'zustand';

export interface Selection {
  id: string;
}

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
  cameraResetNonce: number;
  focusNonce: number;
  toggle: (k: ToggleKey) => void;
  select: (id: string | null) => void;
  resetCamera: () => void;
  focusSelection: () => void;
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
  cameraResetNonce: 0,
  focusNonce: 0,
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<UIState>),
  select: (id) => set({ selection: id ? { id } : null }),
  resetCamera: () => set((s) => ({ cameraResetNonce: s.cameraResetNonce + 1 })),
  focusSelection: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
}));
