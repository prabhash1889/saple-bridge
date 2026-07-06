import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { nowIso } from '../lib/date';
import { toErrorMessage } from '../lib/errors';
import { createId } from '../lib/id';
import { enqueueWrite } from '../lib/writeQueue';
import type { Task, TaskColumn, TaskPriority } from '../types/task';
export type { AgentConfig, Task, TaskColumn, TaskPriority } from '../types/task';

interface KanbanState {
  tasks: Task[];
  loadedProjectPath: string | null;
  loading: boolean;
  error: string | null;
  
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

export const useKanbanStore = create<KanbanState>((set, get) => ({
  tasks: [],
  loadedProjectPath: null,
  loading: false,
  error: null,

  loadTasks: async (projectPath, force = false) => {
    if (get().loading || (!force && get().loadedProjectPath === projectPath)) return;
    set({ loading: true, error: null });
    try {
      const content = await invoke<string>('read_project_file', {
        projectPath,
        filePath: '.saple/tasks.json',
      });
      const parsed = JSON.parse(content) as Partial<Task>[];
      const tasks = parsed.map(normalizeTask);
      if (JSON.stringify(parsed) !== JSON.stringify(tasks)) {
        await saveTasks(projectPath, tasks);
      }
      set({ tasks, loadedProjectPath: projectPath, loading: false });
    } catch (err: unknown) {
      // If file not found, it's a new project; initialize empty task list
      const message = toErrorMessage(err);
      if (message.includes('File not found')) {
        set({ tasks: [], loadedProjectPath: projectPath, loading: false });
      } else {
        set({ error: message, loading: false });
      }
    }
  },

  addTask: async (projectPath, taskData) => {
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
    }
  },

  updateTask: async (projectPath, id, updates) => {
    const previous = get().tasks;
    const updatedTasks = previous.map((t) =>
      t.id === id ? { ...t, ...updates, updatedAt: nowIso() } : t
    );
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to update task: ${toErrorMessage(err)}` });
    }
  },

  deleteTask: async (projectPath, id) => {
    const previous = get().tasks;
    const updatedTasks = previous.filter((t) => t.id !== id);
    set({ tasks: updatedTasks, error: null });
    try {
      await saveTasks(projectPath, updatedTasks);
    } catch (err: unknown) {
      set({ tasks: previous, error: `Failed to delete task: ${toErrorMessage(err)}` });
    }
  },

  moveTask: async (projectPath, id, targetColumn) => {
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
