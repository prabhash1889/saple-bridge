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
      getLayout: (path) => normalize(get().layouts[path]),
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
    },
  ),
);
