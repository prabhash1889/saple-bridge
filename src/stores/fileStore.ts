import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number | null;
}

interface FileState {
  files: FileEntry[];
  activeFile: string | null;
  fileContent: string;
  loading: boolean;
  error: string | null;
  
  loadFiles: (projectPath: string, root?: string) => Promise<void>;
  loadFileContent: (projectPath: string, filePath: string) => Promise<void>;
  saveFileContent: (projectPath: string, filePath: string, content: string) => Promise<void>;
  openExternal: (projectPath: string, filePath: string) => Promise<void>;
  setActiveFile: (filePath: string | null) => void;
  clearError: () => void;
  reset: () => void;
}

export const useFileStore = create<FileState>((set, get) => ({
  files: [],
  activeFile: null,
  fileContent: '',
  loading: false,
  error: null,

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
        loading: false 
      });
    } catch (err: unknown) {
      set({ error: toErrorMessage(err), loading: false });
    }
  },

  saveFileContent: async (projectPath, filePath, content) => {
    set({ loading: true, error: null });
    try {
      await invoke('write_text_file', {
        projectPath,
        filePath,
        content,
      });
      set({ fileContent: content, loading: false });
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

  setActiveFile: (filePath) => set({ 
    activeFile: filePath,
    fileContent: filePath ? get().fileContent : '',
    error: null
  }),
  
  clearError: () => set({ error: null }),

  // Clear all file state — called when switching workspaces so the viewer and
  // tree don't show a previous workspace's files.
  reset: () => set({ files: [], activeFile: null, fileContent: '', error: null, loading: false }),
}));
