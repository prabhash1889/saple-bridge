import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';

export interface GitFileStatus {
  path: string;
  status: string; // 'modified' | 'added' | 'deleted' | 'untracked'
  insertions?: number;
  deletions?: number;
  staged?: boolean;
}

export interface ReviewRecord {
  taskId: string;
  sessionId: string;
  title: string;
  status: 'pending' | 'approved' | 'rejected';
  provider: string;
  model: string;
  role: string;
  changedFiles: GitFileStatus[];
  viewedFiles: string[];
  testOutput?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitDiffSummary {
  branch: string;
  files: GitFileStatus[];
  totalInsertions: number;
  totalDeletions: number;
}

interface ReviewState {
  reviews: Record<string, ReviewRecord>; // taskId -> ReviewRecord
  activeTaskId: string | null;
  loading: boolean;
  error: string | null;
  diffCache: Record<string, string>; // filePath -> diffText

  loadReviewRecord: (projectPath: string, taskId: string) => Promise<ReviewRecord>;
  createReviewRecord: (projectPath: string, taskId: string, sessionId: string) => Promise<ReviewRecord>;
  refreshReviewRecord: (projectPath: string, taskId: string, sessionId: string) => Promise<ReviewRecord>;
  submitReviewDecision: (
    projectPath: string,
    taskId: string,
    decision: 'approve' | 'reject',
    notes?: string
  ) => Promise<void>;
  loadGitDiff: (projectPath: string, filePath: string) => Promise<string>;
  setActiveTaskId: (taskId: string | null) => void;
  setFileStaged: (projectPath: string, taskId: string, filePath: string, staged: boolean) => Promise<void>;
  setFileViewed: (projectPath: string, taskId: string, filePath: string, viewed: boolean) => Promise<void>;
  commitStaged: (projectPath: string, message: string) => Promise<string>;
}

export const useReviewStore = create<ReviewState>((set, get) => ({
  reviews: {},
  activeTaskId: null,
  loading: false,
  error: null,
  diffCache: {},

  setActiveTaskId: (taskId) => set({ activeTaskId: taskId, diffCache: {} }),

  loadReviewRecord: async (projectPath, taskId) => {
    set({ loading: true, error: null });
    try {
      const record = await invoke<ReviewRecord>('read_review_record', { projectPath, taskId });
      set((state) => ({
        reviews: { ...state.reviews, [taskId]: record },
        loading: false,
      }));
      return record;
    } catch (err) {
      set({ error: toErrorMessage(err), loading: false });
      throw err;
    }
  },

  createReviewRecord: async (projectPath, taskId, sessionId) => {
    set({ loading: true, error: null });
    try {
      const record = await invoke<ReviewRecord>('create_review_record', {
        projectPath,
        taskId,
        sessionId,
      });
      set((state) => ({
        reviews: { ...state.reviews, [taskId]: record },
        loading: false,
      }));
      return record;
    } catch (err) {
      set({ error: toErrorMessage(err), loading: false });
      throw err;
    }
  },

  refreshReviewRecord: async (projectPath, taskId, sessionId) => {
    set({ loading: true, error: null });
    try {
      // create_review_record re-pulls git status and rewrites changedFiles for an
      // existing record, so reuse it to refresh after the agent made more changes.
      const record = await invoke<ReviewRecord>('create_review_record', {
        projectPath,
        taskId,
        sessionId,
      });
      set((state) => ({
        reviews: { ...state.reviews, [taskId]: record },
        diffCache: {}, // Invalidate cached diffs; files on disk have changed.
        loading: false,
      }));
      return record;
    } catch (err) {
      set({ error: toErrorMessage(err), loading: false });
      throw err;
    }
  },

  submitReviewDecision: async (projectPath, taskId, decision, notes) => {
    set({ loading: true, error: null });
    try {
      await invoke('submit_review_decision', {
        projectPath,
        taskId,
        decision,
        notes,
      });
      // reload record after decision
      await get().loadReviewRecord(projectPath, taskId);
      set({ loading: false });
    } catch (err) {
      set({ error: toErrorMessage(err), loading: false });
      throw err;
    }
  },

  // Stage/unstage one changed file and mirror the result into the record so the
  // checkbox reflects git's index without a full record refresh.
  setFileStaged: async (projectPath, taskId, filePath, staged) => {
    await invoke(staged ? 'git_stage_file' : 'git_unstage_file', { projectPath, filePath });
    set((state) => {
      const record = state.reviews[taskId];
      if (!record) return state;
      return {
        reviews: {
          ...state.reviews,
          [taskId]: {
            ...record,
            changedFiles: record.changedFiles.map((f) =>
              f.path === filePath ? { ...f, staged } : f
            ),
          },
        },
      };
    });
  },

  // Persist the reviewer's viewed checkmark and mirror it into the record.
  setFileViewed: async (projectPath, taskId, filePath, viewed) => {
    await invoke('set_file_viewed', { projectPath, taskId, filePath, viewed });
    set((state) => {
      const record = state.reviews[taskId];
      if (!record) return state;
      const viewedFiles = record.viewedFiles.filter((p) => p !== filePath);
      if (viewed) viewedFiles.push(filePath);
      return {
        reviews: {
          ...state.reviews,
          [taskId]: { ...record, viewedFiles },
        },
      };
    });
  },

  // Commit whatever is staged. Returns git's own summary line for the toast.
  commitStaged: async (projectPath, message) => {
    return await invoke<string>('git_commit', { projectPath, message });
  },

  loadGitDiff: async (projectPath, filePath) => {
    const cacheKey = `${projectPath}:${filePath}`;
    const cached = get().diffCache[cacheKey];
    if (cached) return cached;

    try {
      const diff = await invoke<string>('git_diff_file', { projectPath, filePath });
      set((state) => ({
        diffCache: { ...state.diffCache, [cacheKey]: diff },
      }));
      return diff;
    } catch (err) {
      console.error('Failed to load git diff for file:', filePath, err);
      return `Error loading diff: ${toErrorMessage(err)}`;
    }
  },
}));
