import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';
import { useConfirmStore } from './confirmStore';

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
  // Whether the active file has unsaved edits (single editor, so one flag suffices).
  dirty: boolean;
  gitStatus: GitStatusMap;
  loading: boolean;
  error: string | null;
  // One-shot request (from the command palette) for the Files room to open its Search tab.
  pendingSearchOpen: boolean;

  requestSearch: () => void;
  consumeSearchRequest: () => void;
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
  // Load content and mark the file active + open in a tab. Assumes any unsaved-edit
  // guard has already run (see `openFile`).
  const doOpen = async (projectPath: string, filePath: string) => {
    set((s) => ({ openFiles: prependTab(s.openFiles, filePath), dirty: false }));
    await get().loadFileContent(projectPath, filePath);
  };

  return {
    files: [],
    activeFile: null,
    fileContent: '',
    openFiles: [],
    dirty: false,
    gitStatus: {},
    loading: false,
    error: null,
    pendingSearchOpen: false,

    requestSearch: () => set({ pendingSearchOpen: true }),
    consumeSearchRequest: () => set({ pendingSearchOpen: false }),

    loadFiles: async (projectPath, root = '') => {
      set({ loading: true, error: null });
      try {
        const files = await invoke<FileEntry[]>('list_project_files', {
          projectPath,
          root,
          depth: 8, // Browse up to 8 levels by default
        });
        set({ files, loading: false });
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

    setActiveFile: (filePath) =>
      set({
        activeFile: filePath,
        fileContent: filePath ? get().fileContent : '',
        error: null,
      }),

    clearError: () => set({ error: null }),

    // Clear all file state — called when switching workspaces so the viewer and
    // tree don't show a previous workspace's files.
    reset: () =>
      set({
        files: [],
        activeFile: null,
        fileContent: '',
        openFiles: [],
        dirty: false,
        gitStatus: {},
        pendingSearchOpen: false,
        error: null,
        loading: false,
      }),
  };
});
