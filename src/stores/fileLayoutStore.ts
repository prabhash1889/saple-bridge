import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// P12: Files-room view state (expanded folders + open editor tabs) lives in its own tiny persisted
// store rather than inside fileStore. fileStore is reset on every project switch and holds transient
// content; this store keeps the *layout* durable across room switches, project switches, and
// restart - the same pattern terminalLayoutStore uses for terminals.
export interface SavedFileLayout {
  // Expanded folder paths (project-relative), open editor tabs (most-recent-first), and the active
  // tab. Stale entries are pruned by fileStore when the file list loads, not here.
  expanded: string[];
  openFiles: string[];
  activeFile: string | null;
  // Files side-panel (terminals room) open state + width, so it survives room/project switches and
  // restart the same way the browser panel does. Optional for backward compat with v1 layouts.
  panelOpen?: boolean;
  panelWidth?: number;
}

interface FileLayoutState {
  // Keyed by workspace *path* (stable across restart / reopen), like terminalLayoutStore.
  savedLayouts: Record<string, SavedFileLayout>;
  setLayout: (path: string, layout: SavedFileLayout) => void;
  clearLayout: (path: string) => void;
}

export const useFileLayoutStore = create<FileLayoutState>()(
  persist(
    (set) => ({
      savedLayouts: {},
      setLayout: (path, layout) =>
        set((state) => ({ savedLayouts: { ...state.savedLayouts, [path]: layout } })),
      clearLayout: (path) =>
        set((state) => {
          if (!state.savedLayouts[path]) return {};
          const next = { ...state.savedLayouts };
          delete next[path];
          return { savedLayouts: next };
        }),
    }),
    {
      name: 'saple-bridge-file-layouts',
      version: 1,
    },
  ),
);
