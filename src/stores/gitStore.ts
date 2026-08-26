import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export type RemoteAction = 'fetch' | 'pull' | 'push';

export interface BranchSyncState {
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface RemoteResult {
  ok: boolean;
  conflicts: boolean;
  message: string;
}

export interface Checkpoint {
  id: string;
  commit: string;
}

interface GitState {
  // Per-project latest branch sync state; null while loading/unavailable.
  syncState: Record<string, BranchSyncState | null>;

  refreshSyncState: (projectPath: string) => Promise<BranchSyncState | null>;
  runRemote: (projectPath: string, action: RemoteAction) => Promise<RemoteResult>;
}

export const useGitStore = create<GitState>()((set, get) => ({
  syncState: {},

  refreshSyncState: async (projectPath) => {
    try {
      const state = await invoke<BranchSyncState>('git_branch_sync_state', { projectPath });
      set((prev) => ({ syncState: { ...prev.syncState, [projectPath]: state } }));
      return state;
    } catch {
      // Detached HEAD or non-git workspace: render as unavailable, not an error toast.
      set((prev) => ({ syncState: { ...prev.syncState, [projectPath]: null } }));
      return null;
    }
  },

  runRemote: async (projectPath, action) => {
    // Literal command names at each call site keep the IPC contract test happy.
    const result =
      action === 'fetch'
        ? await invoke<RemoteResult>('git_fetch', { projectPath })
        : action === 'pull'
          ? await invoke<RemoteResult>('git_pull', { projectPath })
          : await invoke<RemoteResult>('git_push', { projectPath });
    // Pull/fetch can change ahead/behind; push can change the upstream.
    await get().refreshSyncState(projectPath);
    return result;
  },
}));
