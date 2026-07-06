import { describe, it, expect, vi } from 'vitest';

// kanbanStore imports Tauri IPC at module scope; stub it so normalizeTask runs without a webview.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { normalizeTask } from './kanbanStore';

describe('normalizeTask backward compatibility', () => {
  // A task exactly as Phase-4-era .saple/tasks.json files stored it: no dueDate/checklist.
  const legacyTask = {
    id: 'task-1',
    title: 'Old task',
    description: 'desc',
    column: 'progress' as const,
    priority: 'high' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    labels: ['a'],
    targetFiles: ['src/x.ts'],
    acceptanceCriteria: ['works'],
  };

  it('leaves tasks without the Phase 5 fields byte-identical after normalize', () => {
    const normalized = normalizeTask(legacyTask);
    // dueDate/checklist stay undefined, so JSON round-trips unchanged and an old
    // tasks.json is not rewritten on load.
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(legacyTask));
  });

  it('passes through dueDate and checklist when present', () => {
    const normalized = normalizeTask({
      ...legacyTask,
      dueDate: '2026-07-10',
      checklist: [{ text: 'step 1', done: true }],
    });
    expect(normalized.dueDate).toBe('2026-07-10');
    expect(normalized.checklist).toEqual([{ text: 'step 1', done: true }]);
  });

  it('drops a malformed checklist instead of crashing', () => {
    const normalized = normalizeTask({ ...legacyTask, checklist: 'not-an-array' as never });
    expect(normalized.checklist).toBeUndefined();
  });
});
