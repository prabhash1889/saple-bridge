import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { createId } from '../lib/id';

export type ViewType = 'dashboard' | 'terminals' | 'kanban' | 'memory' | 'swarm' | 'review' | 'settings' | 'editor';

export interface WorkspaceConfig {
  workspaceId: string;
  workspaceName: string;
  memoryMode: 'saple' | 'bridge-compatible' | 'both';
  defaultProvider: string;
  defaultModelByProvider: Record<string, string>;
  maxParallelAgents: number;
  enableEditMode: boolean;
  verificationPresets: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceSummary {
  path: string;
  name: string;
  writable: boolean;
  isGitRepo: boolean;
  branch?: string;
  hasSapleConfig: boolean;
  hasBridgeMemory: boolean;
  hasMcpConfig: boolean;
}

// A workspace instance is a single sidebar entry. The same folder can be opened
// multiple times: each opening is a distinct instance with its own `id` (used to
// key independent terminal sets) while sharing the on-disk `.saple/*` state that is
// keyed by `path`. Duplicate openings get a parenthesized suffix in `name` (e.g.
// "myrepo", "myrepo (2)", "myrepo (3)").
export interface WorkspaceInstance {
  id: string;
  path: string;
  name: string;
}

// One entry per distinct workspace path the user has activated, newest first.
// `openedAt` records when each path was last opened so the home page can surface
// the workspace that was active before the app last closed (always the top entry).
export interface WorkspaceHistoryEntry {
  path: string;
  name: string;
  openedAt: number;
}

// Legacy (v0) persisted shape read by the `migrate` step. v0 stored `openWorkspacePaths`
// instead of `openWorkspaces`; the index signature carries through any other persisted keys.
interface PersistedProjectStateV0 {
  openWorkspaces?: unknown;
  openWorkspacePaths?: string[];
  currentProjectPath?: string;
  [key: string]: unknown;
}

// The subset of ProjectState written to storage (see `partialize` below) and produced by `migrate`.
type PersistedProjectState = Pick<
  ProjectState,
  | 'currentProjectPath'
  | 'currentProjectName'
  | 'currentWorkspaceId'
  | 'activeView'
  | 'recentProjects'
  | 'workspaceHistory'
  | 'openWorkspaces'
>;

const basename = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

// Display name for a new instance of `path`: the bare basename when it's the first
// opening, otherwise the basename with the lowest free parenthesized number
// ("base (2)", "base (3)", ...).
const makeWorkspaceName = (path: string, existing: WorkspaceInstance[]) => {
  const base = basename(path);
  const taken = new Set(existing.filter((w) => w.path === path).map((w) => w.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} (${n})`)) n += 1;
  return `${base} (${n})`;
};

interface ProjectState {
  currentProjectPath: string | null;
  currentProjectName: string | null;
  currentWorkspaceId: string | null;
  activeView: ViewType;
  recentProjects: string[];
  workspaceHistory: WorkspaceHistoryEntry[];
  openWorkspaces: WorkspaceInstance[];
  workspaceConfig: WorkspaceConfig | null;
  workspaceSummary: WorkspaceSummary | null;
  workspaceLoading: boolean;
  workspaceError: string | null;
  // One-shot request for which Settings tab to open on next render (e.g. the command palette's
  // "Run diagnostics"). ProjectSettings consumes and clears it on mount/change.
  pendingSettingsTab: string | null;

  setProjectPath: (path: string | null) => void;
  setActiveView: (view: ViewType) => void;
  setPendingSettingsTab: (tab: string | null) => void;
  addRecentProject: (path: string) => void;
  clearRecentProjects: () => void;
  clearWorkspaceHistory: () => void;
  addWorkspace: (path: string) => Promise<void>;
  openWorkspace: (path: string) => Promise<void>;
  openWorkspaceInstance: (id: string) => Promise<void>;
  closeWorkspace: (id: string) => void;
  moveWorkspace: (id: string, direction: 'up' | 'down') => void;
  renameWorkspace: (id: string, name: string) => void;
  refreshWorkspace: () => Promise<void>;
  updateWorkspaceConfig: (config: Partial<WorkspaceConfig>) => Promise<void>;
  checkPathExists: (path: string) => Promise<boolean>;
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => {
      // Load config + summary for the active path and record it in recents. Shared by
      // every code path that activates a workspace (add / open / switch instance).
      const loadWorkspaceData = async (path: string) => {
        set({ workspaceLoading: true, workspaceError: null });
        try {
          await invoke('ensure_workspace_dirs', { projectPath: path });
          const config = await invoke<WorkspaceConfig>('ensure_project_config', { projectPath: path });
          const summary = await invoke<WorkspaceSummary>('get_workspace_summary', { projectPath: path });
          set((state) => ({
            workspaceConfig: config,
            workspaceSummary: summary,
            recentProjects: [path, ...state.recentProjects.filter((p) => p !== path)].slice(0, 10),
            workspaceHistory: [
              { path, name: basename(path), openedAt: Date.now() },
              ...state.workspaceHistory.filter((e) => e.path !== path),
            ].slice(0, 20),
            workspaceLoading: false,
          }));
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          set({ workspaceError: msg, workspaceLoading: false });
        }
      };

      return {
        currentProjectPath: null,
        currentProjectName: null,
        currentWorkspaceId: null,
        activeView: 'dashboard',
        recentProjects: [],
        workspaceHistory: [],
        openWorkspaces: [],
        workspaceConfig: null,
        workspaceSummary: null,
        workspaceLoading: false,
        workspaceError: null,
        pendingSettingsTab: null,

        setPendingSettingsTab: (tab) => set({ pendingSettingsTab: tab }),

        setProjectPath: (path) => set((state) => {
          if (!path) {
            return {
              currentProjectPath: null,
              currentProjectName: null,
              currentWorkspaceId: null,
              workspaceConfig: null,
              workspaceSummary: null,
            };
          }
          const existing = state.openWorkspaces.find((w) => w.path === path);
          if (existing) {
            return {
              currentProjectPath: path,
              currentProjectName: existing.name,
              currentWorkspaceId: existing.id,
            };
          }
          const instance: WorkspaceInstance = {
            id: createId('ws'),
            path,
            name: makeWorkspaceName(path, state.openWorkspaces),
          };
          return {
            currentProjectPath: path,
            currentProjectName: instance.name,
            currentWorkspaceId: instance.id,
            openWorkspaces: [...state.openWorkspaces, instance],
          };
        }),

        // Explicit "add workspace" action: always creates a NEW instance, so the same
        // folder can be opened multiple times (numbered in the sidebar).
        addWorkspace: async (path) => {
          const instance: WorkspaceInstance = {
            id: createId('ws'),
            path,
            name: makeWorkspaceName(path, get().openWorkspaces),
          };
          set((state) => ({
            openWorkspaces: [...state.openWorkspaces, instance],
            currentWorkspaceId: instance.id,
            currentProjectPath: path,
            currentProjectName: instance.name,
            workspaceConfig: null,
            workspaceSummary: null,
          }));
          await loadWorkspaceData(path);
        },

        // Open a folder by path: focus the first existing instance for it, or create
        // one if none is open. Used by recents, folder pickers, and the command palette
        // so casual reopening doesn't spam duplicates (only the "+" button duplicates).
        openWorkspace: async (path) => {
          const existing = get().openWorkspaces.find((w) => w.path === path);
          if (existing) {
            await get().openWorkspaceInstance(existing.id);
            return;
          }
          await get().addWorkspace(path);
        },

        // Switch the active workspace to a specific instance by id.
        openWorkspaceInstance: async (id) => {
          const instance = get().openWorkspaces.find((w) => w.id === id);
          if (!instance) return;
          set({
            currentWorkspaceId: instance.id,
            currentProjectPath: instance.path,
            currentProjectName: instance.name,
            workspaceConfig: null,
            workspaceSummary: null,
          });
          await loadWorkspaceData(instance.path);
        },

        refreshWorkspace: async () => {
          const path = get().currentProjectPath;
          if (!path) return;
          // openWorkspace already loads config + summary for the active path. The App mount
          // effect also calls refreshWorkspace on every path change, which would re-run
          // get_workspace_summary (a git spawn) a second time within ~1s. Skip when the
          // summary is already loaded for this exact path; cold start (persisted path, no
          // openWorkspace) still falls through and fetches because summary is not persisted.
          if (get().workspaceSummary?.path === path && get().workspaceConfig) return;
          try {
            const config = await invoke<WorkspaceConfig>('read_project_config', { projectPath: path });
            const summary = await invoke<WorkspaceSummary>('get_workspace_summary', { projectPath: path });
            set({ workspaceConfig: config, workspaceSummary: summary });
          } catch {
            // ignore refresh errors
          }
        },

        updateWorkspaceConfig: async (updates) => {
          const path = get().currentProjectPath;
          const current = get().workspaceConfig;
          if (!path || !current) return;
          try {
            const merged = { ...current, ...updates };
            const updated = await invoke<WorkspaceConfig>('write_project_config', {
              projectPath: path,
              config: merged,
            });
            set({ workspaceConfig: updated });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            set({ workspaceError: msg });
          }
        },

        checkPathExists: async (p) => {
          try {
            const summary = await invoke<WorkspaceSummary>('get_workspace_summary', { projectPath: p });
            return summary.writable;
          } catch {
            return false;
          }
        },

        setActiveView: (view) => set({ activeView: view }),

        addRecentProject: (path) => set((state) => {
          const filtered = state.recentProjects.filter((p) => p !== path);
          return {
            recentProjects: [path, ...filtered].slice(0, 10),
          };
        }),

        clearRecentProjects: () => set({ recentProjects: [] }),

        clearWorkspaceHistory: () => set({ workspaceHistory: [] }),

        closeWorkspace: (id) => set((state) => {
          const openWorkspaces = state.openWorkspaces.filter((w) => w.id !== id);
          if (state.currentWorkspaceId !== id) {
            return { openWorkspaces };
          }

          const next = openWorkspaces[0] ?? null;
          if (!next) {
            return {
              openWorkspaces,
              currentWorkspaceId: null,
              currentProjectPath: null,
              currentProjectName: null,
              workspaceConfig: null,
              workspaceSummary: null,
            };
          }

          return {
            openWorkspaces,
            currentWorkspaceId: next.id,
            currentProjectPath: next.path,
            currentProjectName: next.name,
            workspaceConfig: null,
            workspaceSummary: null,
          };
        }),

        // Reorder a workspace instance by swapping it with its neighbour. The rendered
        // list follows array order, and openWorkspaces is persisted, so this is all it takes.
        moveWorkspace: (id, direction) => set((state) => {
          const index = state.openWorkspaces.findIndex((w) => w.id === id);
          if (index === -1) return {};
          const target = direction === 'up' ? index - 1 : index + 1;
          if (target < 0 || target >= state.openWorkspaces.length) return {};
          const openWorkspaces = [...state.openWorkspaces];
          [openWorkspaces[index], openWorkspaces[target]] = [openWorkspaces[target], openWorkspaces[index]];
          return { openWorkspaces };
        }),

        // Rename a workspace instance. Display-only and per-instance: on-disk `.saple/*`
        // state is keyed by `path`, so the name never touches disk. Empty names are ignored.
        renameWorkspace: (id, name) => set((state) => {
          const trimmed = name.trim();
          if (!trimmed) return {};
          const openWorkspaces = state.openWorkspaces.map((w) =>
            w.id === id ? { ...w, name: trimmed } : w
          );
          return state.currentWorkspaceId === id
            ? { openWorkspaces, currentProjectName: trimmed }
            : { openWorkspaces };
        }),
      };
    },
    {
      name: 'saple-bridge-project-store',
      version: 1,
      // v0 stored `openWorkspacePaths: string[]`. Convert each path to an instance and
      // point currentWorkspaceId at the one matching the persisted active path.
      migrate: (persistedState, _version) => {
        const persisted = persistedState as PersistedProjectStateV0 | undefined;
        if (!persisted || Array.isArray(persisted.openWorkspaces)) {
          return persisted as PersistedProjectState | undefined;
        }
        const paths: string[] = Array.isArray(persisted.openWorkspacePaths) ? persisted.openWorkspacePaths : [];
        const openWorkspaces: WorkspaceInstance[] = [];
        for (const p of paths) {
          openWorkspaces.push({ id: createId('ws'), path: p, name: makeWorkspaceName(p, openWorkspaces) });
        }
        let currentWorkspaceId: string | null = null;
        if (persisted.currentProjectPath) {
          let inst = openWorkspaces.find((w) => w.path === persisted.currentProjectPath);
          if (!inst) {
            inst = {
              id: createId('ws'),
              path: persisted.currentProjectPath,
              name: makeWorkspaceName(persisted.currentProjectPath, openWorkspaces),
            };
            openWorkspaces.unshift(inst);
          }
          currentWorkspaceId = inst.id;
        }
        // openWorkspacePaths is a legacy persisted field we intentionally drop.
        const { openWorkspacePaths: _openWorkspacePaths, ...rest } = persisted;
        return { ...rest, openWorkspaces, currentWorkspaceId } as PersistedProjectState;
      },
      partialize: (state) => ({
        currentProjectPath: state.currentProjectPath,
        currentProjectName: state.currentProjectName,
        currentWorkspaceId: state.currentWorkspaceId,
        activeView: state.activeView,
        recentProjects: state.recentProjects,
        workspaceHistory: state.workspaceHistory,
        openWorkspaces: state.openWorkspaces,
      }),
    }
  )
);
