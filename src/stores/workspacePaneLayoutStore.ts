import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface WorkspacePaneLayout {
  memoryListWidth: number;
  reviewQueueWidth: number;
  reviewActionsWidth: number;
}

const DEFAULT_LAYOUT: WorkspacePaneLayout = {
  memoryListWidth: 320,
  reviewQueueWidth: 280,
  reviewActionsWidth: 320,
};

export const PANE_WIDTH_LIMITS = {
  memoryList: { min: 220, max: 520 },
  reviewQueue: { min: 220, max: 520 },
  reviewActions: { min: 260, max: 560 },
} as const;

interface WorkspacePaneLayoutState {
  layouts: Record<string, WorkspacePaneLayout>;
  getLayout: (path: string) => WorkspacePaneLayout;
  setLayout: (path: string, patch: Partial<WorkspacePaneLayout>) => void;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const normalize = (layout?: Partial<WorkspacePaneLayout>): WorkspacePaneLayout => ({
  memoryListWidth: clamp(
    layout?.memoryListWidth ?? DEFAULT_LAYOUT.memoryListWidth,
    PANE_WIDTH_LIMITS.memoryList.min,
    PANE_WIDTH_LIMITS.memoryList.max,
  ),
  reviewQueueWidth: clamp(
    layout?.reviewQueueWidth ?? DEFAULT_LAYOUT.reviewQueueWidth,
    PANE_WIDTH_LIMITS.reviewQueue.min,
    PANE_WIDTH_LIMITS.reviewQueue.max,
  ),
  reviewActionsWidth: clamp(
    layout?.reviewActionsWidth ?? DEFAULT_LAYOUT.reviewActionsWidth,
    PANE_WIDTH_LIMITS.reviewActions.min,
    PANE_WIDTH_LIMITS.reviewActions.max,
  ),
});

export const useWorkspacePaneLayoutStore = create<WorkspacePaneLayoutState>()(
  persist(
    (set, get) => ({
      layouts: {},
      // Must return a stable reference: components select this via zustand, and a fresh
      // object per call makes React's getSnapshot loop forever (error #185, blank app).
      // Safe because setLayout and the rehydration merge below only store normalized objects.
      getLayout: (path) => get().layouts[path] ?? DEFAULT_LAYOUT,
      setLayout: (path, patch) =>
        set((state) => ({
          layouts: {
            ...state.layouts,
            [path]: normalize({ ...state.layouts[path], ...patch }),
          },
        })),
    }),
    {
      name: 'saple-bridge-workspace-pane-layouts',
      version: 1,
      // Clamp persisted values once at load instead of on every read.
      merge: (persisted, current) => {
        const raw = (persisted as Partial<WorkspacePaneLayoutState> | undefined)?.layouts ?? {};
        const layouts: Record<string, WorkspacePaneLayout> = {};
        for (const [path, layout] of Object.entries(raw)) layouts[path] = normalize(layout);
        return { ...current, layouts };
      },
    },
  ),
);
