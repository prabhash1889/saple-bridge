import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';
import { useConfirmStore } from './confirmStore';
import { useFileLayoutStore } from './fileLayoutStore';
import { useProjectStore } from './projectStore';
import { useBrowserStore } from './browserStore';

// Files side-panel default/min width (terminals room). Sized so the 200px tree plus a usable code
// column both fit; MIN keeps the editor from collapsing on drag.
export const DEFAULT_PANEL_WIDTH = 580;
export const MIN_PANEL_WIDTH = 400;

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number | null;
}

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  lineText: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

/** git status per relative path, as reported by `git_status` (modified/added/deleted/untracked). */
export type GitStatusMap = Record<string, string>;

interface FileState {
  files: FileEntry[];
  activeFile: string | null;
  fileContent: string;
  // Open editor tabs, most-recent-first. Only the active tab holds live content.
  openFiles: string[];
  // Expanded folder paths in the tree. Lives here (not FileTree-local) so it survives room switches
  // and is persisted per workspace via fileLayoutStore (P12).
  expanded: Set<string>;
  // Workspace path the current layout is captured under (null = no project / not persisted).
  layoutPath: string | null;
  // Whether the active file has unsaved edits (single editor, so one flag suffices).
  dirty: boolean;
  gitStatus: GitStatusMap;
  loading: boolean;
  error: string | null;
  // One-shot request (from the command palette) for the Files room to open its Search tab.
  pendingSearchOpen: boolean;
  // Files side-panel (terminals room) open state + width, for the current workspace. Persisted per
  // workspace via fileLayoutStore, mutually exclusive with the browser panel (see subscription below).
  panelOpen: boolean;
  panelWidth: number;

  requestSearch: () => void;
  consumeSearchRequest: () => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  setPanelWidth: (width: number) => void;
  // Restore this workspace's persisted layout (expanded folders + tabs), or clear when path is null.
  restoreLayout: (projectPath: string | null) => void;
  toggleExpanded: (path: string) => void;
  setExpandedPaths: (paths: string[]) => void;
  loadFiles: (projectPath: string, root?: string) => Promise<void>;
  loadGitStatus: (projectPath: string) => Promise<void>;
  loadFileContent: (projectPath: string, filePath: string) => Promise<void>;
  // Open a file into a tab, guarding against discarding unsaved edits.
  openFile: (projectPath: string, filePath: string) => void;
  closeTab: (projectPath: string, filePath: string) => void;
  setDirty: (dirty: boolean) => void;
  saveFileContent: (projectPath: string, filePath: string, content: string) => Promise<void>;
  openExternal: (projectPath: string, filePath: string) => Promise<void>;
  createFile: (projectPath: string, filePath: string) => Promise<void>;
  createDirectory: (projectPath: string, dirPath: string) => Promise<void>;
  renamePath: (projectPath: string, fromPath: string, toPath: string) => Promise<void>;
  deletePath: (projectPath: string, filePath: string) => Promise<void>;
  searchInFiles: (projectPath: string, query: string) => Promise<SearchResult>;
  setActiveFile: (filePath: string | null) => void;
  clearError: () => void;
  reset: () => void;
}

// Move `path` to the front of the tab list, de-duplicating.
const prependTab = (openFiles: string[], path: string): string[] => [
  path,
  ...openFiles.filter((p) => p !== path),
];

export const useFileStore = create<FileState>((set, get) => {
  // Snapshot the current layout (expanded folders + tabs) into the persisted per-workspace store.
  // No-op until a workspace is restored, so unit tests and the no-project state don't write.
  const captureLayout = () => {
    const { layoutPath, expanded, openFiles, activeFile, panelOpen, panelWidth } = get();
    if (!layoutPath) return;
    useFileLayoutStore.getState().setLayout(layoutPath, {
      expanded: [...expanded],
      openFiles,
      activeFile,
      panelOpen,
      panelWidth,
    });
  };

  // Load content and mark the file active + open in a tab. Assumes any unsaved-edit
  // guard has already run (see `openFile`).
  const doOpen = async (projectPath: string, filePath: string) => {
    set((s) => ({ openFiles: prependTab(s.openFiles, filePath), dirty: false }));
    captureLayout();
    await get().loadFileContent(projectPath, filePath);
  };

  return {
    files: [],
    activeFile: null,
    fileContent: '',
    openFiles: [],
    expanded: new Set<string>(),
    layoutPath: null,
    dirty: false,
    gitStatus: {},
    loading: false,
    error: null,
    pendingSearchOpen: false,
    panelOpen: false,
    panelWidth: DEFAULT_PANEL_WIDTH,

    requestSearch: () => set({ pendingSearchOpen: true }),
    consumeSearchRequest: () => set({ pendingSearchOpen: false }),

    openPanel: () => {
      // Only one aux panel per terminals row: opening files closes the browser (current workspace).
      const wsId = useProjectStore.getState().currentWorkspaceId;
      if (wsId) useBrowserStore.getState().closePanel(wsId);
      set({ panelOpen: true });
      captureLayout();
    },
    closePanel: () => {
      if (!get().panelOpen) return;
      set({ panelOpen: false });
      captureLayout();
    },
    togglePanel: () => {
      if (get().panelOpen) get().closePanel();
      else get().openPanel();
    },
    setPanelWidth: (width) => {
      set({ panelWidth: width });
      captureLayout();
    },

    restoreLayout: (projectPath) => {
      if (!projectPath) {
        get().reset();
        return;
      }
      const saved = useFileLayoutStore.getState().savedLayouts[projectPath];
      set({
        layoutPath: projectPath,
        files: [],
        gitStatus: {},
        error: null,
        loading: false,
        pendingSearchOpen: false,
        fileContent: '',
        dirty: false,
        expanded: new Set(saved?.expanded ?? []),
        openFiles: saved?.openFiles ?? [],
        activeFile: saved?.activeFile ?? null,
        panelOpen: saved?.panelOpen ?? false,
        panelWidth: saved?.panelWidth ?? DEFAULT_PANEL_WIDTH,
      });
      // Show the persisted active tab's content immediately. Best-effort: if it was deleted while
      // this workspace was closed, loadFiles' prune (on the next tree load) drops it.
      const active = get().activeFile;
      if (active) void get().loadFileContent(projectPath, active);
    },

    toggleExpanded: (path) => {
      set((s) => {
        const expanded = new Set(s.expanded);
        if (expanded.has(path)) expanded.delete(path);
        else expanded.add(path);
        return { expanded };
      });
      captureLayout();
    },

    setExpandedPaths: (paths) => {
      if (paths.length === 0) return;
      set((s) => {
        const expanded = new Set(s.expanded);
        for (const p of paths) expanded.add(p);
        return { expanded };
      });
      captureLayout();
    },

    loadFiles: async (projectPath, root = '') => {
      set({ loading: true, error: null });
      try {
        const raw = await invoke<FileEntry[]>('list_project_files', {
          projectPath,
          root,
          depth: 8, // Browse up to 8 levels by default
        });
        // No listing (mock / IPC hiccup): don't prune against nothing, just clear the tree.
        if (!Array.isArray(raw)) {
          set({ files: [], loading: false });
          return;
        }
        // Prune persisted layout to paths that still exist, so deleted/renamed entries are not
        // resurrected on load (P12). ponytail: pruning uses the depth-8 listing, so a tab opened
        // deeper than 8 levels (e.g. via search) can be dropped; deepen the listing if that bites.
        const dirPaths = new Set(raw.filter((f) => f.isDir).map((f) => f.path));
        const filePaths = new Set(raw.filter((f) => !f.isDir).map((f) => f.path));
        const prevActive = get().activeFile;
        set((s) => {
          const expanded = new Set([...s.expanded].filter((p) => dirPaths.has(p)));
          const openFiles = s.openFiles.filter((p) => filePaths.has(p));
          const activeFile =
            s.activeFile && filePaths.has(s.activeFile) ? s.activeFile : (openFiles[0] ?? null);
          return { files: raw, loading: false, expanded, openFiles, activeFile };
        });
        captureLayout();
        // If pruning dropped the active file, show the fallback tab (or clear the viewer).
        const active = get().activeFile;
        if (active !== prevActive) {
          if (active) await get().loadFileContent(projectPath, active);
          else set({ fileContent: '', dirty: false });
        }
      } catch (err: unknown) {
        set({ error: toErrorMessage(err), loading: false });
      }
    },

    loadGitStatus: async (projectPath) => {
      try {
        const statuses = await invoke<{ path: string; status: string }[]>('git_status', {
          projectPath,
        });
        const map: GitStatusMap = {};
        for (const s of statuses) map[s.path] = s.status;
        set({ gitStatus: map });
      } catch {
        // Not a git repo, or git unavailable: no badges, not an error worth surfacing.
        set({ gitStatus: {} });
      }
    },

    loadFileContent: async (projectPath, filePath) => {
      set({ loading: true, error: null });
      try {
        const content = await invoke<string>('read_text_file', {
          projectPath,
          filePath,
        });
        set({
          activeFile: filePath,
          fileContent: content,
          loading: false,
        });
      } catch (err: unknown) {
        set({ error: toErrorMessage(err), loading: false });
      }
    },

    openFile: (projectPath, filePath) => {
      if (get().activeFile === filePath) return;
      if (get().dirty) {
        useConfirmStore.getState().confirm({
          title: 'Discard unsaved changes?',
          message: 'The current file has unsaved edits. Opening another file will discard them.',
          confirmLabel: 'Discard & Open',
          onConfirm: () => {
            set({ dirty: false });
            void doOpen(projectPath, filePath);
          },
        });
        return;
      }
      void doOpen(projectPath, filePath);
    },

    closeTab: (projectPath, filePath) => {
      const proceed = () => {
        set((s) => {
          const openFiles = s.openFiles.filter((p) => p !== filePath);
          // Closing a non-active tab leaves the active file untouched.
          if (s.activeFile !== filePath) {
            return { openFiles };
          }
          // Activate the previous tab in the (post-filter) list, or clear if none remain.
          const idx = s.openFiles.indexOf(filePath);
          const next = openFiles[Math.max(0, idx - 1)] ?? null;
          return { openFiles, activeFile: next, fileContent: next ? s.fileContent : '', dirty: false };
        });
        const next = get().activeFile;
        if (next && get().openFiles.includes(next)) {
          void get().loadFileContent(projectPath, next);
        }
        captureLayout();
      };

      if (get().dirty && get().activeFile === filePath) {
        useConfirmStore.getState().confirm({
          title: 'Discard unsaved changes?',
          message: 'This file has unsaved edits. Closing it will discard them.',
          confirmLabel: 'Discard & Close',
          onConfirm: proceed,
        });
        return;
      }
      proceed();
    },

    setDirty: (dirty) => set({ dirty }),

    saveFileContent: async (projectPath, filePath, content) => {
      set({ loading: true, error: null });
      try {
        await invoke('write_text_file', {
          projectPath,
          filePath,
          content,
        });
        set({ fileContent: content, loading: false, dirty: false });
        void get().loadGitStatus(projectPath);
      } catch (err: unknown) {
        const msg = toErrorMessage(err);
        set({ error: msg, loading: false });
        throw new Error(msg);
      }
    },

    openExternal: async (projectPath, filePath) => {
      try {
        await invoke('open_in_external_editor', {
          projectPath,
          filePath,
        });
      } catch (err: unknown) {
        set({ error: toErrorMessage(err) });
      }
    },

    createFile: async (projectPath, filePath) => {
      await invoke('create_file', { projectPath, filePath });
      await get().loadFiles(projectPath);
      void get().loadGitStatus(projectPath);
    },

    createDirectory: async (projectPath, dirPath) => {
      await invoke('create_directory', { projectPath, dirPath });
      await get().loadFiles(projectPath);
    },

    renamePath: async (projectPath, fromPath, toPath) => {
      await invoke('rename_path', { projectPath, fromPath, toPath });
      set((s) => {
        // Follow the rename in open tabs and the active file.
        const openFiles = s.openFiles.map((p) => (p === fromPath ? toPath : p));
        const activeFile = s.activeFile === fromPath ? toPath : s.activeFile;
        return { openFiles, activeFile };
      });
      await get().loadFiles(projectPath);
      void get().loadGitStatus(projectPath);
    },

    deletePath: async (projectPath, filePath) => {
      await invoke('delete_path', { projectPath, filePath });
      // Close any open tab for the deleted path (or a descendant of a deleted folder).
      set((s) => {
        const isAffected = (p: string) => p === filePath || p.startsWith(`${filePath}/`);
        const openFiles = s.openFiles.filter((p) => !isAffected(p));
        const activeGone = s.activeFile != null && isAffected(s.activeFile);
        return {
          openFiles,
          activeFile: activeGone ? (openFiles[0] ?? null) : s.activeFile,
          fileContent: activeGone && openFiles.length === 0 ? '' : s.fileContent,
          dirty: activeGone ? false : s.dirty,
        };
      });
      const next = get().activeFile;
      if (next && get().openFiles.includes(next)) {
        await get().loadFileContent(projectPath, next);
      }
      await get().loadFiles(projectPath);
      void get().loadGitStatus(projectPath);
    },

    searchInFiles: async (projectPath, query) => {
      return await invoke<SearchResult>('search_in_files', { projectPath, query });
    },

    setActiveFile: (filePath) => {
      set({
        activeFile: filePath,
        fileContent: filePath ? get().fileContent : '',
        error: null,
      });
      captureLayout();
    },

    clearError: () => set({ error: null }),

    // Clear all file state — called for the no-project state (via restoreLayout(null)) so the
    // viewer and tree don't show a previous workspace's files. Drops layoutPath so nothing is
    // captured until a workspace is restored again.
    reset: () =>
      set({
        files: [],
        activeFile: null,
        fileContent: '',
        openFiles: [],
        expanded: new Set<string>(),
        layoutPath: null,
        dirty: false,
        gitStatus: {},
        pendingSearchOpen: false,
        error: null,
        loading: false,
        panelOpen: false,
        panelWidth: DEFAULT_PANEL_WIDTH,
      }),
  };
});

// Only one aux panel (files or browser) shows in the terminals row at a time. When the browser
// panel opens for the active workspace, close the files panel. One-directional (fileStore ->
// browserStore) so there's no import cycle; the reverse is handled inside openPanel above.
useBrowserStore.subscribe((state) => {
  if (!useFileStore.getState().panelOpen) return;
  const wsId = useProjectStore.getState().currentWorkspaceId;
  const browserOpen = wsId ? !!state.workspaces[wsId]?.isOpen : false;
  if (browserOpen) useFileStore.getState().closePanel();
});
