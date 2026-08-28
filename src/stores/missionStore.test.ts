import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every Tauri invoke so we can assert exactly which engine commands the
// store calls - the projection-only rule means the store must never fabricate state.
const invokeMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useMissionStore } from './missionStore';
import type { MissionState, MissionSummary } from '../types/mission';

const PROJECT = 'C:/proj';

const summaryOf = (overrides: Partial<MissionSummary> = {}): MissionSummary => ({
  id: 'msn_a',
  title: 'Add OAuth login',
  status: 'draft',
  taskTotal: 0,
  taskCompleted: 0,
  updatedAt: '2026-08-26T00:00:00Z',
  ...overrides,
});

// Engine-shaped state.json payload (camelCase serde mirror). The round-trip test below
// asserts this survives a full store pass without field drift against src/types/mission.ts.
const engineState: MissionState = {
  id: 'msn_a',
  revision: 3,
  status: 'running',
  spec: {
    title: 'Add OAuth login',
    objective: 'One paragraph objective.',
    acceptance: ['npm test passes'],
    maxParallel: 4,
    maxRounds: 12,
    budgetUsdCap: 15,
    worktreeMode: 'shared',
    coordinator: { provider: 'opencode', model: 'default', permission: 'full_access' },
  },
  tasks: [
    {
      id: 'task_1',
      title: 'Setup',
      kind: 'implement',
      spec: 'do it',
      deps: [],
      fanout: 1,
      status: 'ready',
    },
    {
      id: 'task_2',
      title: 'Verify',
      kind: 'verify',
      spec: 'check it',
      deps: ['task_1'],
      fanout: 1,
      status: 'pending',
      gateId: null,
    },
  ],
  events: [{ seq: 1, kind: 'started', payload: { requestId: 'r1' }, at: '2026-08-26T00:00:01Z' }],
  idempotency: { r1: { applied: true, revision: 2 } },
  createdAt: '2026-08-26T00:00:00Z',
  updatedAt: '2026-08-26T00:00:02Z',
};

beforeEach(() => {
  invokeMock.mockClear();
  useMissionStore.setState({
    missions: [],
    loadedProjectPath: null,
    loading: false,
    error: null,
    activeId: null,
    activeProjectPath: null,
    activeState: null,
    activeDoc: null,
    activeWarnings: [],
    activeLoading: false,
  });
});

describe('missionStore projection (M1)', () => {
  it('loadMissions invokes the list command and stores summaries', async () => {
    invokeMock.mockResolvedValue([summaryOf(), summaryOf({ id: 'msn_b', title: 'Second' })]);

    await useMissionStore.getState().loadMissions(PROJECT);

    const calls = invokeMock.mock.calls.filter((c) => c[0] === 'mission_list');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ projectPath: PROJECT });
    expect(useMissionStore.getState().missions).toHaveLength(2);
    expect(useMissionStore.getState().loadedProjectPath).toBe(PROJECT);
    expect(useMissionStore.getState().error).toBeNull();
  });

  it('openMission folds loaded read results including warnings', async () => {
    invokeMock.mockResolvedValue({
      status: 'loaded',
      state: engineState,
      doc: '---\ntitle: Add OAuth login\n---\nbody',
      warnings: ['state.json was missing and was rebuilt from mission.md'],
    });

    await useMissionStore.getState().openMission(PROJECT, 'msn_a');

    expect(invokeMock.mock.calls[0]).toEqual([
      'mission_read',
      { projectPath: PROJECT, id: 'msn_a' },
    ]);
    const state = useMissionStore.getState();
    expect(state.activeId).toBe('msn_a');
    expect(state.activeState?.revision).toBe(3);
    expect(state.activeDoc).toContain('title: Add OAuth login');
    expect(state.activeWarnings).toHaveLength(1);
    // Projection-only rule: the store keeps what the engine reported, verbatim.
    expect(state.activeState?.tasks[1].deps).toEqual(['task_1']);
  });

  it('surfaces corrupt reads as an error instead of fabricating state', async () => {
    invokeMock.mockResolvedValue({
      status: 'corrupt',
      error: 'Failed to parse mission state.json',
      backupPath: 'C:/proj/.saple/missions/msn_a/state.json.corrupt-1.bak',
    });

    await useMissionStore.getState().openMission(PROJECT, 'msn_a');

    const state = useMissionStore.getState();
    expect(state.activeState).toBeNull();
    expect(state.error).toContain('preserved copy');
  });

  it('createMission prepends the summary and opens the new mission', async () => {
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'mission_create') return summaryOf({ id: 'msn_new', title: 'New Mission' });
      if (cmd === 'mission_read') {
        return {
          status: 'loaded',
          state: { ...engineState, id: 'msn_new' },
          doc: '---\n---\n',
          warnings: [],
        };
      }
      throw new Error(`unexpected command ${cmd}`);
    });

    const id = await useMissionStore
      .getState()
      .createMission(PROJECT, { title: 'New Mission', objective: 'obj' });

    expect(id).toBe('msn_new');
    const createArgs = invokeMock.mock.calls.find((c) => c[0] === 'mission_create')?.[1];
    expect(createArgs).toMatchObject({
      projectPath: PROJECT,
      title: 'New Mission',
      objective: 'obj',
    });
    expect(useMissionStore.getState().missions[0].id).toBe('msn_new');
    expect(useMissionStore.getState().activeId).toBe('msn_new');
  });

  it('saveTasks passes CAS revision through to the engine', async () => {
    useMissionStore.setState({
      activeId: 'msn_a',
      activeProjectPath: PROJECT,
      activeState: engineState,
    });
    invokeMock.mockImplementation(async (...args: unknown[]) => {
      const cmd = args[0] as string;
      if (cmd === 'mission_set_tasks') return { ...engineState, revision: 4 };
      if (cmd === 'mission_list') return [summaryOf()];
      throw new Error(`unexpected command ${cmd}`);
    });

    await useMissionStore
      .getState()
      .saveTasks(PROJECT, 'msn_a', 3, [{ key: 't1', title: 'Only', deps: [] }]);

    expect(invokeMock.mock.calls.find((c) => c[0] === 'mission_set_tasks')?.[1]).toEqual({
      projectPath: PROJECT,
      id: 'msn_a',
      expectedRevision: 3,
      tasks: [{ key: 't1', title: 'Only', deps: [] }],
    });
    expect(useMissionStore.getState().activeState?.revision).toBe(4);
  });

  it('runCommand mints a fresh request_id per call and reports engine rejections', async () => {
    useMissionStore.setState({
      activeId: 'msn_a',
      activeProjectPath: PROJECT,
      activeState: engineState,
    });
    invokeMock.mockRejectedValue("cannot start a mission from status 'running'");

    await expect(
      useMissionStore.getState().runCommand(PROJECT, 'msn_a', { type: 'start' }),
    ).rejects.toBeDefined();

    const call = invokeMock.mock.calls.find((c) => c[0] === 'mission_command');
    expect(call).toBeDefined();
    const args = call![1] as { expectedRevision: number; requestId: string; cmd: unknown };
    expect(args.expectedRevision).toBe(3);
    expect(args.requestId.startsWith('ui_')).toBe(true);
    expect(useMissionStore.getState().error).toContain('cannot start');
  });

  it('keeps engine-shaped payloads intact across a full store round trip', async () => {
    invokeMock.mockResolvedValue({
      status: 'loaded',
      state: engineState,
      doc: 'doc',
      warnings: [],
    });
    await useMissionStore.getState().openMission(PROJECT, 'msn_a');

    const stored = JSON.parse(JSON.stringify(useMissionStore.getState().activeState));
    expect(stored).toEqual(engineState);
  });

  it('ignores a save response after the selected mission changes', async () => {
    let resolveSave: ((state: MissionState) => void) | undefined;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'mission_update_doc') {
        return new Promise<MissionState>((resolve) => {
          resolveSave = resolve;
        });
      }
      return [];
    });
    useMissionStore.setState({
      activeId: 'msn_a',
      activeProjectPath: PROJECT,
      activeState: engineState,
      activeDoc: 'old doc',
    });

    const pending = useMissionStore.getState().saveDoc(PROJECT, 'msn_a', 'new doc', 3);
    useMissionStore.setState({
      activeId: 'msn_b',
      activeProjectPath: PROJECT,
      activeState: { ...engineState, id: 'msn_b' },
      activeDoc: 'mission b',
    });
    resolveSave?.({ ...engineState, revision: 4 });
    await pending;

    expect(useMissionStore.getState().activeId).toBe('msn_b');
    expect(useMissionStore.getState().activeDoc).toBe('mission b');
  });

  it('invalidates an in-flight open when the mission is closed', async () => {
    let resolveRead: ((result: unknown) => void) | undefined;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'mission_read') {
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      }
      return [];
    });

    const pending = useMissionStore.getState().openMission(PROJECT, 'msn_a');
    useMissionStore.getState().closeMission();
    resolveRead?.({ status: 'loaded', state: engineState, doc: 'doc', warnings: [] });
    await pending;

    expect(useMissionStore.getState().activeId).toBeNull();
    expect(useMissionStore.getState().activeState).toBeNull();
  });

  it('clears the active mission when loading a different project', async () => {
    useMissionStore.setState({
      loadedProjectPath: 'C:/old-project',
      activeId: 'msn_a',
      activeProjectPath: 'C:/old-project',
      activeState: engineState,
      activeDoc: 'old doc',
    });
    invokeMock.mockResolvedValue([]);

    await useMissionStore.getState().loadMissions(PROJECT);

    expect(useMissionStore.getState().activeId).toBeNull();
    expect(useMissionStore.getState().activeState).toBeNull();
    expect(useMissionStore.getState().activeProjectPath).toBeNull();
  });
});
