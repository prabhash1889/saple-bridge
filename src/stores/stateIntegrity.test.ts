import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 2 state-integrity behaviors shared across stores: structured load outcomes,
// request-sequence tokens, and corrupt-state write blocking.

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Real serialization semantics are irrelevant here; run tasks inline but keep ordering.
vi.mock('../lib/writeQueue', () => ({
  enqueueWrite: (_key: string, fn: () => unknown) => Promise.resolve().then(fn),
}));

import { useKanbanStore } from './kanbanStore';
import { useAgentSessionStore } from './agentSessionStore';

beforeEach(() => {
  invokeMock.mockReset();
  useKanbanStore.setState({
    tasks: [],
    loadedProjectPath: null,
    loading: false,
    error: null,
    corruptState: null,
  });
  useAgentSessionStore.setState({
    sessions: [],
    loaded: false,
    loadedProjectPath: null,
    corruptState: null,
  });
});

const loaded = (content: unknown) => Promise.resolve({ status: 'loaded', content: JSON.stringify(content) });

describe('kanbanStore state integrity (Phase 2)', () => {
  it('rapid project switching commits only the latest load', async () => {
    // Project A's disk read is slow; project B's is fast. A must never win.
    let resolveA: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: { filePath?: string; projectPath?: string }) => {
      if (cmd !== 'load_state_file') return Promise.resolve();
      if (args.projectPath === 'C:/proj-a') {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return loaded([{ id: 'b1', title: 'B task', column: 'backlog' }]);
    });

    const loadA = useKanbanStore.getState().loadTasks('C:/proj-a', true);
    await useKanbanStore.getState().loadTasks('C:/proj-b', true);
    expect(useKanbanStore.getState().tasks.map((t) => t.id)).toEqual(['b1']);

    // The stale A response lands late; it must be discarded instead of overwriting B.
    resolveA({ status: 'loaded', content: JSON.stringify([{ id: 'a1', title: 'A task' }]) });
    await loadA;
    expect(useKanbanStore.getState().tasks.map((t) => t.id)).toEqual(['b1']);
  });

  it('corrupt tasks.json is surfaced, never treated as empty, and blocks writes', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'load_state_file') {
        return Promise.resolve({
          status: 'corrupt',
          error: 'Failed to parse .saple/tasks.json as JSON: boom',
          backupPath: 'C:/proj/.saple/tasks.corrupt-123.bak',
        });
      }
      return Promise.resolve();
    });

    await useKanbanStore.getState().loadTasks('C:/proj', true);

    const state = useKanbanStore.getState();
    expect(state.corruptState).toMatchObject({ filePath: '.saple/tasks.json' });
    expect(state.tasks).toEqual([]);

    // Mutations are refused while corruption is unresolved...
    await useKanbanStore.getState().addTask('C:/proj', { title: 'new' } as never);
    expect(useKanbanStore.getState().error).toContain('corrupt');
    await useKanbanStore.getState().updateTask('C:/proj', 't1', { column: 'done' });
    expect(useKanbanStore.getState().error).toContain('corrupt');

    // ...so no save ever reaches disk that could overwrite the corrupt bytes.
    const saves = invokeMock.mock.calls.filter((c) => c[0] === 'write_project_file');
    expect(saves).toHaveLength(0);

    // Recovery clears the flag and a fresh load restores normal operation.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'load_state_file' ? loaded([]) : Promise.resolve(),
    );
    useKanbanStore.setState({ corruptState: null });
    await useKanbanStore.getState().loadTasks('C:/proj', true);
    expect(useKanbanStore.getState().corruptState).toBeNull();
    expect(useKanbanStore.getState().error).toBeNull();
  });

  it('missing file initializes empty state without any save', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'load_state_file' ? Promise.resolve({ status: 'missing' }) : Promise.resolve(),
    );

    await useKanbanStore.getState().loadTasks('C:/fresh-proj', true);

    expect(useKanbanStore.getState().tasks).toEqual([]);
    expect(useKanbanStore.getState().corruptState).toBeNull();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'write_project_file')).toHaveLength(0);
  });

  it('locked and ioError outcomes surface errors without resetting state', async () => {
    invokeMock.mockImplementation(() => Promise.resolve({ status: 'locked' }));
    await useKanbanStore.getState().loadTasks('C:/proj', true);
    expect(useKanbanStore.getState().error).toContain('locked');

    invokeMock.mockImplementation(() => Promise.resolve({ status: 'ioError', error: 'denied' }));
    await useKanbanStore.getState().loadTasks('C:/proj', true);
    expect(useKanbanStore.getState().error).toContain('denied');
    expect(useKanbanStore.getState().corruptState).toBeNull();
  });
});

describe('agentSessionStore state integrity (Phase 2)', () => {
  it('corrupt sessions.json blocks persistence until recovery', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'load_state_file') {
        return Promise.resolve({
          status: 'corrupt',
          error: 'parse failure',
          backupPath: 'C:/proj/.saple/agents/sessions.corrupt-1.bak',
        });
      }
      return Promise.resolve();
    });

    await useAgentSessionStore.getState().loadSessions('C:/proj', true);
    expect(useAgentSessionStore.getState().corruptState).toBeTruthy();

    // The next save must skip writing entirely - no clobbering of the corrupt evidence.
    await useAgentSessionStore.getState().saveSessions('C:/proj');
    expect(invokeMock.mock.calls.some((c) => c[0] === 'write_project_file')).toBe(false);
  });

  it('rapid switching keeps only the latest project\'s sessions', async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    invokeMock.mockImplementation((cmd: string, args: { projectPath?: string }) => {
      if (cmd !== 'load_state_file') return Promise.resolve();
      if (args.projectPath === 'C:/slow') {
        return new Promise((resolve) => {
          resolveSlow = resolve;
        });
      }
      return loaded([{ id: 'fast-1' }]);
    });

    const slowLoad = useAgentSessionStore.getState().loadSessions('C:/slow', true);
    await useAgentSessionStore.getState().loadSessions('C:/fast', true);
    resolveSlow({ status: 'loaded', content: JSON.stringify([{ id: 'slow-1' }]) });
    await slowLoad;

    expect(useAgentSessionStore.getState().sessions.map((s) => s.id)).toEqual(['fast-1']);
  });
});
