import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SavedWorkspaceLayout } from './terminalStore';
import type { GridLayout } from '../components/terminal/terminalLayout';

// Saved terminal layouts live in their own tiny persisted store rather than inside
// terminalStore. terminalStore updates state on every output flush (command detection),
// and wrapping it in `persist` would write the whole slice to localStorage per frame.
// Here, writes happen only when a layout actually changes (pane add/remove/focus/maximize)
// or when the user finishes dragging a grid gutter.
interface TerminalLayoutState {
  // Keyed by workspace *path* (the stable identity across app restart / reopen-from-History,
  // unlike the per-session workspace instance id).
  savedLayouts: Record<string, SavedWorkspaceLayout>;
  // Per-workspace resize fractions for the tiled terminal grid. Only present when the user has
  // dragged a gutter; adding/removing a pane re-balances and overwrites this with an even split.
  gridSizes: Record<string, GridLayout>;
  setLayout: (path: string, layout: SavedWorkspaceLayout) => void;
  clearLayout: (path: string) => void;
  setGridSize: (path: string, layout: GridLayout) => void;
}

export const useTerminalLayoutStore = create<TerminalLayoutState>()(
  persist(
    (set) => ({
      savedLayouts: {},
      gridSizes: {},
      setLayout: (path, layout) =>
        set((state) => ({ savedLayouts: { ...state.savedLayouts, [path]: layout } })),
      clearLayout: (path) =>
        set((state) => {
          if (!state.savedLayouts[path]) return {};
          const next = { ...state.savedLayouts };
          delete next[path];
          return { savedLayouts: next };
        }),
      setGridSize: (path, layout) =>
        set((state) => ({ gridSizes: { ...state.gridSizes, [path]: layout } })),
    }),
    {
      name: 'saple-bridge-terminal-layouts',
      version: 2,
      migrate: (state) => ({
        savedLayouts: (state as Partial<TerminalLayoutState>)?.savedLayouts ?? {},
        gridSizes: (state as Partial<TerminalLayoutState>)?.gridSizes ?? {},
      }),
    },
  ),
);
