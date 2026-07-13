import { describe, it, expect, vi, beforeEach } from 'vitest';

// swarmStore persists template presets via zustand/persist; give it a working storage so the
// middleware doesn't warn in the node test environment.
vi.hoisted(() => {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
  });
});

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Minimal stand-ins for the stores swarmStore reaches into, so tests exercise the scheduler
// without the terminal/PTY machinery.
const addPaneMock = vi.hoisted(() => vi.fn());
const removePaneMock = vi.hoisted(() => vi.fn());
const terminalSessions = vi.hoisted(() => ({} as Record<string, unknown>));
const maxPaneLimitRef = vi.hoisted(() => ({ value: 16 }));
vi.mock('./terminalStore', () => ({
  useTerminalStore: {
    getState: () => ({
      addPane: addPaneMock,
      removePane: removePaneMock,
      updateSession: vi.fn(),
      getMaxPaneLimit: () => maxPaneLimitRef.value,
      sessions: terminalSessions,
    }),
  },
}));

vi.mock('./agentSessionStore', () => ({
  useAgentSessionStore: {
    getState: () => ({
      createSession: vi.fn(async () => ({ id: 'session-1' })),
      getSessionByTerminalId: vi.fn(() => undefined),
      completeSession: vi.fn(async () => {}),
    }),
  },
}));

vi.mock('../lib/desktopNotifications', () => ({
  notifyAgentStatusChanged: vi.fn(),
}));

import { useSwarmStore, type SwarmAgent, type AgentStatus } from './swarmStore';

const PROJECT = 'C:/proj';

const agent = (
  id: string,
  dependencies: string[] = [],
  status: AgentStatus = dependencies.length > 0 ? 'waiting' : 'idle',
  extra: Partial<SwarmAgent> = {},
): SwarmAgent => ({
  id,
  name: id,
  role: 'builder',
  model: 'default',
  systemPrompt: 'test',
  dependencies,
  status,
  ...extra,
});

const getAgent = (id: string) => useSwarmStore.getState().activeAgents.find((a) => a.id === id)!;

const seed = (agents: SwarmAgent[], status: 'running' | 'paused' = 'running') => {
  useSwarmStore.setState({
    swarmId: 'swarm-test',
    swarmName: 'Test',
    mission: 'test mission',
    skills: [],
    contextFiles: [],
    status,
    swarmActive: true,
    activeAgents: agents,
    loadedProjectPath: PROJECT,
  });
};

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  addPaneMock.mockReset().mockResolvedValue('pane-1');
  removePaneMock.mockReset().mockResolvedValue(undefined);
  maxPaneLimitRef.value = 16;
  for (const key of Object.keys(terminalSessions)) delete terminalSessions[key];
  seed([]);
});

describe('runAgentScan scheduling', () => {
  it('launches only agents whose dependencies are all done', async () => {
    seed([agent('root'), agent('dependent', ['root'])]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);
    // The launch itself is fire-and-forget; wait for the status to land.
    await vi.waitFor(() => expect(getAgent('root').status).toBe('running'));

    expect(getAgent('dependent').status).toBe('waiting');
    expect(addPaneMock).toHaveBeenCalledTimes(1);
  });

  it('advances dependents when a dependency completes', async () => {
    seed([agent('root', [], 'done'), agent('dependent', ['root'])]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);
    await vi.waitFor(() => expect(getAgent('dependent').status).toBe('running'));
  });

  it('blocks dependents of a failed agent and fails the swarm once all agents are finished', async () => {
    seed([agent('root', [], 'failed'), agent('dependent', ['root'])]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(getAgent('dependent').status).toBe('blocked');
    expect(useSwarmStore.getState().status).toBe('failed');
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('blocks transitively through a chain of dependents', async () => {
    seed([agent('a', [], 'failed'), agent('b', ['a']), agent('c', ['b'])]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(getAgent('b').status).toBe('blocked');
    expect(getAgent('c').status).toBe('blocked');
  });

  it('marks the swarm completed when every agent is done', async () => {
    seed([agent('a', [], 'done'), agent('b', ['a'], 'done')]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(useSwarmStore.getState().status).toBe('completed');
  });

  it('an agent in review gates its dependents without failing the swarm', async () => {
    seed([agent('gatekeeper', [], 'review'), agent('dependent', ['gatekeeper'])]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(getAgent('dependent').status).toBe('waiting');
    expect(useSwarmStore.getState().status).toBe('running');
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('does not launch anything while the swarm is paused', async () => {
    seed([agent('root')], 'paused');

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(getAgent('root').status).toBe('idle');
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('caps concurrent launches at the parallel-agent limit', async () => {
    maxPaneLimitRef.value = 2;
    seed([agent('a'), agent('b'), agent('c'), agent('d')]);

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);
    // addPane fires inside the fire-and-forget launch, a few awaits after the status flips to
    // 'starting', so wait on the spawn count itself rather than on status (which lands earlier).
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalledTimes(2));

    const active = useSwarmStore
      .getState()
      .activeAgents.filter((x) => x.status === 'running' || x.status === 'starting');
    expect(active.length).toBe(2);

    // The over-limit agents stay unstarted until a slot frees; only two panes were spawned.
    const idle = useSwarmStore
      .getState()
      .activeAgents.filter((x) => x.status === 'idle' || x.status === 'waiting');
    expect(idle.length).toBe(2);
  });
});

describe('updateAgentStatus', () => {
  it('auto-approve advances review straight to done', async () => {
    seed([agent('auto', [], 'running', { autoApprove: true })]);

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'auto', 'review');

    expect(getAgent('auto').status).toBe('done');
  });

  it('without auto-approve, review waits for a human', async () => {
    seed([agent('manual', [], 'running')]);

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'manual', 'review');

    expect(getAgent('manual').status).toBe('review');
  });

  it('clears a previous statusReason unless the transition provides its own', async () => {
    seed([agent('a', [], 'review', { statusReason: 'Process exited without a completion signal.' })]);

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'a', 'done');

    expect(getAgent('a').statusReason).toBeUndefined();
  });
});

describe('loadSwarmState restart reconciliation', () => {
  const diskState = (agents: SwarmAgent[], status: string) =>
    JSON.stringify({
      swarmId: 'swarm-disk',
      swarmName: 'Disk',
      mission: 'm',
      skills: [],
      contextFiles: [],
      templateId: null,
      agents,
      status,
    });

  it('downgrades running agents with dead terminals to failed and pauses the swarm', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'read_swarm_state') {
        return Promise.resolve(
          diskState([agent('zombie', [], 'running', { terminalId: 'dead-pane' })], 'running'),
        );
      }
      return Promise.resolve(undefined);
    });

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    const zombie = getAgent('zombie');
    expect(zombie.status).toBe('failed');
    expect(zombie.terminalId).toBeUndefined();
    expect(zombie.statusReason).toMatch(/restarted/i);
    expect(useSwarmStore.getState().status).toBe('paused');
    // The reconciled state is persisted back so the zombie doesn't reappear on next load.
    expect(invokeMock).toHaveBeenCalledWith('write_swarm_state', expect.anything());
  });

  it('leaves running agents alone when their terminal still exists', async () => {
    terminalSessions['live-pane'] = { id: 'live-pane' };
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'read_swarm_state') {
        return Promise.resolve(
          diskState([agent('alive', [], 'running', { terminalId: 'live-pane' })], 'running'),
        );
      }
      return Promise.resolve(undefined);
    });

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    expect(getAgent('alive').status).toBe('running');
    expect(useSwarmStore.getState().status).toBe('running');
  });

  it('resets to idle when no state file exists', async () => {
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_swarm_state' ? Promise.reject(new Error('not found')) : Promise.resolve(undefined),
    );

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    expect(useSwarmStore.getState().status).toBe('idle');
    expect(useSwarmStore.getState().activeAgents).toEqual([]);
  });
});
