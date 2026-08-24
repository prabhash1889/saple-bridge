import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { invoke } from '@tauri-apps/api/core';
import { containsUnsafePtyContent, runRejectionFlow } from './reviewRejection';
import { useReviewStore } from '../../stores/reviewStore';

const invokeMock = vi.mocked(invoke);

describe('containsUnsafePtyContent', () => {
  it('flags shell substitution and command chaining', () => {
    expect(containsUnsafePtyContent('run $(rm -rf /)')).toBe(true);
    expect(containsUnsafePtyContent('echo `whoami`')).toBe(true);
    expect(containsUnsafePtyContent('a && b')).toBe(true);
  });

  it('flags control characters', () => {
    expect(containsUnsafePtyContent('bell\u0007here')).toBe(true);
    expect(containsUnsafePtyContent('null\u0000byte')).toBe(true);
    expect(containsUnsafePtyContent('esc\u001B[31m')).toBe(true);
  });

  it('allows ordinary reviewer prose including newlines', () => {
    expect(containsUnsafePtyContent('Please fix the error handling.\nSee line 42.')).toBe(false);
  });
});

const DANGEROUS_NOTES = 'fix $(whoami) && echo `id` \u0007\u0000';

function makeDeps() {
  const store = useReviewStore.getState();
  return {
    projectPath: 'C:/workspaces/demo',
    taskId: 'task-1',
    notes: DANGEROUS_NOTES,
    submitReviewDecision: (...args: Parameters<typeof store.submitReviewDecision>) =>
      store.submitReviewDecision(...args),
    loadTasks: vi.fn().mockResolvedValue(undefined),
    loadSessions: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockResolvedValue({});
});

describe('runRejectionFlow', () => {
  it('never delivers note content to write_pty', async () => {
    await runRejectionFlow(makeDeps());

    const ptyCalls = invokeMock.mock.calls.filter(([cmd]) => cmd === 'write_pty');
    expect(ptyCalls).toHaveLength(0);
  });

  it('persists the notes through the submit_review_decision record path', async () => {
    await runRejectionFlow(makeDeps());

    expect(invokeMock).toHaveBeenCalledWith(
      'submit_review_decision',
      expect.objectContaining({
        projectPath: 'C:/workspaces/demo',
        taskId: 'task-1',
        decision: 'reject',
        notes: DANGEROUS_NOTES,
      })
    );
  });

  it('reloads tasks and sessions so the rejected state propagates', async () => {
    const deps = makeDeps();
    await runRejectionFlow(deps);

    expect(deps.loadTasks).toHaveBeenCalledWith(deps.projectPath, true);
    expect(deps.loadSessions).toHaveBeenCalledWith(deps.projectPath, true);
  });
});
