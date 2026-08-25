import { create } from 'zustand';
import { nowIso } from '../lib/date';
import { toErrorMessage } from '../lib/errors';
import { createId } from '../lib/id';
import { enqueueWrite } from '../lib/writeQueue';
import { notifyTaskReadyForReview } from '../lib/desktopNotifications';
import { recordFailure } from '../lib/failureTracking';
import { loadStateFile, type CorruptState, type StateLoadResult } from '../lib/stateLoad';
import { invoke } from '@tauri-apps/api/core';
import type { Task, TaskColumn, TaskPriority } from '../types/task';
export type { AgentConfig, Task, TaskColumn, TaskPriority } from '../types/task';

const TASKS_FILE = '.saple/tasks.json';

interface KanbanState {
  tasks: Task[];
  loadedProjectPath: string | null;
  loading: boolean;
  error: string | null;
  // Set while the tasks file is corrupt and unresolved; blocks every mutation until recovery.
  corruptState: CorruptState | null;

  loadTasks: (projectPath: string, force?: boolean) => Promise<void>;
  addTask: (projectPath: string, task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'priority'> & { priority?: TaskPriority }) => Promise<void>;
  updateTask: (projectPath: string, id: string, updates: Partial<Task>) => Promise<void>;
  deleteTask: (projectPath: string, id: string) => Promise<void>;
  moveTask: (projectPath: string, id: string, targetColumn: TaskColumn) => Promise<void>;
  reorderTask: (projectPath: string, id: string, targetColumn: TaskColumn, beforeId: string | null) => Promise<void>;
}

// Exported for tests (backward-compat guarantee on .saple/tasks.json).
export const normalizeTask = (task: Partial<Task>): Task => {
  const createdAt = task.createdAt || nowIso();
  return {
    id: task.id || createId('task'),
    title: task.title || 'Untitled task',
    description: task.description || '',
    column: task.column || 'backlog',
    priority: task.priority || 'normal',
    createdAt,
    updatedAt: task.updatedAt || createdAt,
    labels: Array.isArray(task.labels) ? task.labels : [],
    dueDate: task.dueDate,
    checklist: Array.isArray(task.checklist) ? task.checklist : undefined,
    template: task.template,
    targetFiles: task.targetFiles || [],
    acceptanceCriteria: task.acceptanceCriteria || [],
    agentConfig: task.agentConfig,
    terminalId: task.terminalId,
    sessionId: task.sessionId,
  };
};

// Serialized per project so two quick edits (or a drag + an MCP write) can't reorder and
// leave the older snapshot on disk.
const saveTasks = (projectPath: string, tasks: Task[]) =>
  enqueueWrite(`tasks:${projectPath}`, () =>
    invoke('write_project_file', {
      projectPath,
      filePath: '.saple/tasks.json',
      content: JSON.stringify(tasks, null, 2),
    }),
  );

// P13: review signals from task panes whose project isn't the loaded one. The terminal handlers
// can't move a task they can't see, so they queue the pane id here (keyed by project path) and
// loadTasks applies the move when that project's tasks come in. In-memory by design — across a
// restart the PTY is gone and the exit-fallback story starts over.
const pendingTaskReviews = new Map<string, Set<string>>();

export const recordPendingTaskReview = (projectPath: string, terminalId: string): void => {
  const forProject = pendingTaskReviews.get(projectPath) ?? new Set();
  forProject.add(terminalId);
  pendingTaskReviews.set(projectPath, forProject);
};

const consumePendingTaskReviews = (projectPath: string): Set<string> => {
  const forProject = pendingTaskReviews.get(projectPath) ?? new Set<string>();
  pendingTaskReviews.delete(projectPath);
  return forProject;
};

// Currency token for loadTasks: rapid project switches fire overlapping loads, and without this
// an older (slower) response could land after a newer one and commit another project's tasks
// into the current view. Only the latest request may commit (Phase 2: request-sequence tokens).
let loadTasksSeq = 0;

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [],
  loadedProjectPath: null,
  loading: false,
  error: null,
  corruptState: null,

  loadTasks: async (projectPath, force = false) => {
    if (!force && get().loadedProjectPath === projectPath && !get().corruptState) return;
    const token = ++loadTasksSeq;
    set({ loading: true, error: null });

    // The disk read runs on the same queue key as saves, so a watcher-triggered reload always
    // lands AFTER any pending write settles - never between a save's read and its commit.
    let result: StateLoadResult;
    try {
      result = await enqueueWrite(`tasks:${projectPath}`, () => loadStateFile(projectPath, TASKS_FILE));
    } catch (err: unknown) {
      if (token !== loadTasksSeq) return;
      set({ error: toErrorMessage(err), loading: false });
      return;
    }
    if (token !== loadTasksSeq) return; // superseded by a newer load

    switch (result.status) {
      case 'missing': {
        // New project: initialize empty task list.
        set({ tasks: [], loadedProjectPath: projectPath, loading: false, error: null, corruptState: null });
        break;
      }
      case 'loaded': {
        try {
          const parsed = JSON.parse(result.content) as Partial<Task>[];
          const tasks = parsed.map(normalizeTask);
          set({ tasks, loadedProjectPath: projectPath, loading: false, error: null, corruptState: null });
          // Normalization rewrite happens outside the queued read so it can safely re-enqueue.
          if (JSON.stringify(parsed) !== JSON.stringify(tasks)) {
            await saveTasks(projectPath, get().tasks);
          }
          // P13: apply review moves that fired while this project wasn't loaded. Only panes that a
          // task actually links matter; anything else queued (interactive terminals) is dropped.
          for (const terminalId of consumePendingTaskReviews(projectPath)) {
            const task = get().tasks.find((t) => t.terminalId === terminalId);
            if (task && task.column === 'progress') {
              await get().updateTask(projectPath, task.id, { column: 'review' });
              notifyTaskReadyForReview(task.title);
            }
          }
        } catch (err: unknown) {
          // The file parsed in Rust but not here - surface it without overwriting anything.
          set({ error: `Failed to process tasks: ${toErrorMessage(err)}`, loading: false });
        }
        break;
      }
      case 'corrupt': {
        // Fail closed: keep the corrupt file untouched, surface recovery, block mutations.
        set({
          tasks: [],
          loadedProjectPath: projectPath,
          loading: false,
          error: null,
          corruptState: { filePath: TASKS_FILE, error: result.error, backupPath: result.backupPath },
        });
        break;
      }
      case 'locked': {
        set({ error: 'tasks.json is locked by another process; retry shortly.', loading: false });
        break;
      }
      case 'ioError': {
        set({ error: `Failed to read tasks.json: ${result.error}`, loading: false });
        break;
      }
    }
  },

  addTask: async (projectPath, taskData) => {
    if (get().corruptState) {
      set({ error: 'Resolve the corrupted tasks.json before editing tasks.' });
      return;
    }
    const createdAt = nowIso();
    const newTask: Task = {
      ...taskData,
      id: createId('task'),
      priority: taskData.priority || 'normal',
      createdAt,
      updatedAt: createdAt,
    };

    // Optimistic: update UI immediately, then persist and roll back on failure.
    const previous = get().tasks;
    const updatedTasks = [...previous, newTask];
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to save task: ${toErrorMessage(err)}` });
      recordFailure('state-save', `Failed to save task: ${toErrorMessage(err)}`);
    }
  },

  updateTask: async (projectPath, id, updates) => {
    if (get().corruptState) {
      set({ error: 'Resolve the corrupted tasks.json before editing tasks.' });
      return;
    }
    const previous = get().tasks;
    const updatedTasks = previous.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: nowIso() } : t
    );
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to update task: ${toErrorMessage(err)}` });
      recordFailure('state-save', `Failed to update task: ${toErrorMessage(err)}`);
    }
  },

  deleteTask: async (projectPath, id) => {
    if (get().corruptState) {
      set({ error: 'Resolve the corrupted tasks.json before editing tasks.' });
      return;
    }
    const previous = get().tasks;
    const updatedTasks = previous.filter((t) => t.id !== id);
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to delete task: ${toErrorMessage(err)}` });
      recordFailure('state-save', `Failed to delete task: ${toErrorMessage(err)}`);
    }
  },

  moveTask: async (projectPath, id, targetColumn) => {
    if (get().corruptState) {
      set({ error: 'Resolve the corrupted tasks.json before editing tasks.' });
      return;
    }
    const previous = get().tasks;
    const target = previous.find((t) => t.id === id);
    // No-op guard: dropping a card on its current column changes nothing.
    if (!target || target.column === targetColumn) return;

    const updatedTasks = previous.map((t) =>
      t.id === id ? { ...t, column: targetColumn, updatedAt: nowIso() } : t
    );
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to move task: ${toErrorMessage(err)}` });
    }
  },

  reorderTask: async (projectPath, id, targetColumn, beforeId) => {
    if (get().corruptState) {
      set({ error: 'Resolve the corrupted tasks.json before editing tasks.' });
      return;
    }
    const previous = get().tasks;
    const moving = previous.find((t) => t.id === id);
    if (!moving) return;

    // Build the moved task (column may change) and the list without it.
    const columnChanged = moving.column !== targetColumn;
    const movedTask: Task = columnChanged
      ? { ...moving, column: targetColumn, updatedAt: nowIso() }
      : moving;
    const without = previous.filter((t) => t.id !== id);

    // Determine insertion index in the global array, before `beforeId` when given.
    let insertAt = without.length;
    if (beforeId && beforeId !== id) {
      const idx = without.findIndex((t) => t.id === beforeId);
      if (idx !== -1) insertAt = idx;
    }

    const updatedTasks = [
      ...without.slice(0, insertAt),
      movedTask,
      ...without.slice(insertAt),
    ];

    // No-op guard: same column and identical ordering.
    if (
      !columnChanged &&
      updatedTasks.length === previous.length &&
      updatedTasks.every((t, i) => t.id === previous[i].id)
    ) {
      return;
    }

    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to reorder task: ${toErrorMessage(err)}` });
    }
  },
}));
