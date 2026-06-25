import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SavedWorkspaceLayout } from './terminalStore';

// Saved terminal layouts live in their own tiny persisted store rather than inside
// terminalStore. terminalStore updates state on every output flush (command detection),
// and wrapping it in `persist` would write the whole slice to localStorage per frame.
// Here, writes happen only when a layout actually changes (pane add/remove/focus/maximize).
interface TerminalLayoutState {
  // Keyed by workspace *path* (the stable identity across app restart / reopen-from-History,
  // unlike the per-session workspace instance id).
  savedLayouts: Record<string, SavedWorkspaceLayout>;
  setLayout: (path: string, layout: SavedWorkspaceLayout) => void;
  clearLayout: (path: string) => void;
}

export const useTerminalLayoutStore = create<TerminalLayoutState>()(
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
      name: 'saple-bridge-terminal-layouts',
      version: 1,
    },
  ),
);
