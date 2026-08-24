import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';
import type { CorruptState } from '../lib/stateLoad';

export interface GitFileStatus {
  path: string;
  status: string; // 'modified' | 'added' | 'deleted' | 'untracked'
  insertions?: number;
  deletions?: number;
  staged?: boolean;
}

// Phase 3: the repository state this record's evidence was captured against. Approval is
// refused Rust-side when HEAD or the staged/unstaged set no longer matches.
export interface ReviewedEvidence {
  headCommit?: string | null;
  committedAt?: string | null;
  statusHash: string;
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
  reviewedTree?: ReviewedEvidence | null;
  testOutput?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Structured read outcome (Phase 3): missing records may be auto-created, corrupt ones must
// surface recovery UI and are never recreated over.
export type ReviewRecordLoad =
  | { status: 'missing' }
  | { status: 'loaded'; record: ReviewRecord }
  | { status: 'corrupt'; error: string; backupPath: string };

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
  // Current tree identity (status hash) per project. Diff cache keys embed it, so any
  // worktree/staged-set change invalidates every cached diff for that project.
  treeIds: Record<string, string | null>;
  // Set while `.saple/review/<taskId>.json` is corrupt; blocks auto-recreation until recovery.
  corruptState: CorruptState | null;

  loadReviewRecord: (projectPath: string, taskId: string) => Promise<'loaded' | 'missing' | 'corrupt'>;
  createReviewRecord: (projectPath: string, taskId: string, sessionId: string) => Promise<ReviewRecord>;
  refreshReviewRecord: (projectPath: string, taskId: string, sessionId: string) => Promise<ReviewRecord>;
  submitReviewDecision: (
    projectPath: string,
    taskId: string,
    decision: 'approve' | 'reject',
    notes?: string
  ) => Promise<void>;
  loadGitDiff: (projectPath: string, filePath: string) => Promise<string>;
  refreshTreeIdentity: (projectPath: string) => Promise<void>;
  clearCorruptState: () => void;
  setActiveTaskId: (taskId: string | null) => void;
  setFileStaged: (projectPath: string, taskId: string, filePath: string, staged: boolean) => Promise<void>;
  setFileViewed: (projectPath: string, taskId: string, filePath: string, viewed: boolean) => Promise<void>;
  // Commit exactly the record's currently-staged files. Refused backend-side when the index
  // holds anything outside that reviewed path set.
  commitStaged: (projectPath: string, taskId: string, message: string) => Promise<string>;
}

const diffCacheKey = (projectPath: string, treeId: string | null | undefined, filePath: string) =>
  `${projectPath}:${treeId ?? '-'}:${filePath}`;

export const useReviewStore = create<ReviewState>((set, get) => ({
  reviews: {},
  activeTaskId: null,
  loading: false,
  error: null,
  diffCache: {},
  treeIds: {},
  corruptState: null,

  setActiveTaskId: (taskId) => set({ activeTaskId: taskId, diffCache: {} }),

  clearCorruptState: () => set({ corruptState: null }),

  refreshTreeIdentity: async (projectPath) => {
    try {
      const id = await invoke<{ statusHash: string }>('git_tree_identity', { projectPath });
      set((state) => ({ treeIds: { ...state.treeIds, [projectPath]: id.statusHash } }));
    } catch {
      // Non-git workspace: no identity, diffs stay uncached under the '-' key.
      set((state) => ({ treeIds: { ...state.treeIds, [projectPath]: null } }));
    }
  },

  loadReviewRecord: async (projectPath, taskId) => {
    set({ loading: true, error: null });
    try {
      const result = await invoke<ReviewRecordLoad>('read_review_record', { projectPath, taskId });
      if (result.status === 'loaded') {
        set((state) => ({
          reviews: { ...state.reviews, [taskId]: result.record },
          corruptState: null,
          loading: false,
        }));
        await get().refreshTreeIdentity(projectPath);
        return 'loaded';
      }
      if (result.status === 'corrupt') {
        // Fail closed: keep the flag up so nothing recreates over the preserved bytes; the
        // Review room shows recovery guidance instead of the record.
        set({
          corruptState: {
            filePath: `.saple/review/${taskId}.json`,
            error: result.error,
            backupPath: result.backupPath,
          },
          loading: false,
        });
        return 'corrupt';
      }
      set({ loading: false, corruptState: null });
      return 'missing';
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
        corruptState: null,
        loading: false,
      }));
      await get().refreshTreeIdentity(projectPath);
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
      await get().refreshTreeIdentity(projectPath);
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
  // checkbox reflects git's index without a full record refresh. Staging changes what
  // `git diff HEAD` reports, so refresh the tree identity - every cached diff key for
  // this project goes stale at once.
  setFileStaged: async (projectPath, taskId, filePath, staged) => {
    await invoke(staged ? 'git_stage_file' : 'git_unstage_file', { projectPath, filePath });
    await get().refreshTreeIdentity(projectPath);
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

  // Commit exactly the reviewed record's currently-staged files. The backend re-verifies the
  // index against this path set and refuses anything unexpected, so a file an agent slips into
  // the index after review can never ride along.
  commitStaged: async (projectPath, taskId, message) => {
    const record = get().reviews[taskId];
    const paths = (record?.changedFiles ?? []).filter((f) => f.staged).map((f) => f.path);
    return await invoke<string>('git_commit', { projectPath, message, paths });
  },

  loadGitDiff: async (projectPath, filePath) => {
    const cacheKey = diffCacheKey(projectPath, get().treeIds[projectPath], filePath);
    const cached = get().diffCache[cacheKey];
    if (cached !== undefined) return cached;

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
