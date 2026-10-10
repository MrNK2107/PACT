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
  showLabels: boolean;
  showWind: boolean;
  showShards: boolean;
  selection: Selection | null;
  cameraResetNonce: number;
  focusNonce: number;
  toggle: (k: ToggleKey) => void;
  select: (id: string | null) => void;
  resetCamera: () => void;
  focusSelection: () => void;
}

export type ToggleKey = 'showBuildings' | 'showGrid' | 'showRoutes' | 'showWaypoints' | 'showNoFly' | 'showObstacles' | 'showComms' | 'showLabels' | 'showWind' | 'showShards';

export const useUI = create<UIState>((set) => ({
  showBuildings: true,
  showGrid: false,
  showRoutes: true,
  showWaypoints: true,
  showNoFly: true,
  showObstacles: false,
  showComms: false,
  showLabels: true,
  showWind: false,
  showShards: false,
  selection: null,
  cameraResetNonce: 0,
  focusNonce: 0,
  toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<UIState>),
  select: (id) => set({ selection: id ? { id } : null }),
  resetCamera: () => set((s) => ({ cameraResetNonce: s.cameraResetNonce + 1 })),
  focusSelection: () => set((s) => ({ focusNonce: s.focusNonce + 1 })),
}));
