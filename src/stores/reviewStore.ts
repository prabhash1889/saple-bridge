import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';

export interface GitFileStatus {
  path: string;
  status: string; // 'modified' | 'added' | 'deleted' | 'untracked'
  insertions?: number;
  deletions?: number;
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
