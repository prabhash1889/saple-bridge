import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every Tauri invoke so we can assert the canonical control-plane writes the store makes.
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Run queued writes inline (no real serialization needed for the assertions).
vi.mock('../lib/writeQueue', () => ({
  enqueueWrite: (_key: string, fn: () => unknown) => Promise.resolve(fn()),
}));

import { useAgentSessionStore } from './agentSessionStore';

const PROJECT = 'C:/proj';

/** Canonical writes for one file, in order: [id, patch, create] tuples. */
const writesTo = (file: string) =>
  invokeMock.mock.calls
    .filter((c) => c[0] === 'canonical_record_write' && (c[1] as { filePath: string }).filePath === file)
    .map((c) => c[1] as { id: string; patch: Record<string, unknown>; create: boolean });

beforeEach(() => {
  invokeMock.mockClear();
  useAgentSessionStore.setState({ sessions: [], loaded: false, loadedProjectPath: null });
});

describe('agentSessionStore control plane (P0/P3)', () => {
  it('registers exactly one agent record and one run record on launch', async () => {
    const session = await useAgentSessionStore.getState().createSession({
      projectPath: PROJECT,
      name: 'Builder',
      cwd: PROJECT,
      provider: 'codex',
      model: 'default',
      role: 'builder',
      taskId: 'task_1',
      terminalId: 'pane_1',
    });

    expect(session.agentId).toBeTruthy();
    expect(session.runId).toBeTruthy();

    const agents = writesTo('.saple/agents.json');
    const runs = writesTo('.saple/runs.json');
    expect(agents).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(agents[0].create).toBe(true);
    expect(runs[0].patch.agentId).toBe(session.agentId);
    expect(runs[0].patch.status).toBe('running');
  });

  it('finishes the run and writes outcome artifacts on completion', async () => {
    const session = await useAgentSessionStore.getState().createSession({
      projectPath: PROJECT,
      name: 'Builder',
      cwd: PROJECT,
      provider: 'codex',
      model: 'default',
      role: 'builder',
      terminalId: 'pane_1',
    });
    invokeMock.mockClear();

    await useAgentSessionStore.getState().completeSession(PROJECT, session.id, 'done', {
      summary: 'Fixed the auth race',
      changedFiles: ['src/auth.ts'],
      tests: { command: 'npm test', passed: true },
    });

    // Session moved to a terminal state.
    expect(useAgentSessionStore.getState().sessions[0].status).toBe('done');

    // Two artifacts (report + test_result), then the run finished succeeded.
    const artifacts = writesTo('.saple/artifacts.json');
    expect(artifacts.map((a) => a.patch.kind).sort()).toEqual(['report', 'test_result']);

    const runFinish = writesTo('.saple/runs.json').find((r) => r.patch.status === 'succeeded');
    expect(runFinish).toBeTruthy();
    expect(runFinish?.patch.summary).toBe('Fixed the auth race');
    expect(runFinish?.create).toBe(false);
  });

  it('tolerates a completion with no outcome (marker-only fallback)', async () => {
    const session = await useAgentSessionStore.getState().createSession({
      projectPath: PROJECT,
      name: 'Builder',
      cwd: PROJECT,
      provider: 'codex',
      model: 'default',
      role: 'builder',
      terminalId: 'pane_1',
    });
    invokeMock.mockClear();

    await useAgentSessionStore.getState().completeSession(PROJECT, session.id, 'failed');

    expect(writesTo('.saple/artifacts.json')).toHaveLength(0);
    const runFinish = writesTo('.saple/runs.json').find((r) => r.patch.status === 'failed');
    expect(runFinish?.patch.phase).toBe('failed');
  });
});
