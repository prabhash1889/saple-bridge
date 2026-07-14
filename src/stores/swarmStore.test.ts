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
// Per-pane rolling signal tails, as terminalStore would hold them (P13 recovery reads these).
const signalTails = vi.hoisted(() => ({} as Record<string, string>));
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
  getPaneSignalTail: (paneId: string) => signalTails[paneId] ?? '',
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

import { useSwarmStore, recordPendingAgentExit, type SwarmAgent, type AgentStatus } from './swarmStore';
import { useProjectStore } from './projectStore';
import type { WizardLaunchInput } from '../types/wizard';

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
  for (const key of Object.keys(signalTails)) delete signalTails[key];
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

describe('startSwarmFromWizard workspace isolation (P11)', () => {
  it('creates a dedicated workspace instance and pins agent panes to it', async () => {
    const input: WizardLaunchInput = {
      projectPath: PROJECT,
      swarmName: 'Iso',
      mission: 'do work',
      agents: [
        { id: 'root', name: 'root', role: 'builder', provider: 'claude', model: 'default', systemPrompt: 's', dependencies: [], autoApprove: false },
      ],
      skills: [],
      contextFiles: [],
      templateId: null,
    };

    await useSwarmStore.getState().startSwarmFromWizard(input);

    // A new "(swarm)" instance was activated for the same folder.
    const swarmWsId = useSwarmStore.getState().swarmWorkspaceId;
    expect(swarmWsId).toBeTruthy();
    const instance = useProjectStore.getState().openWorkspaces.find((w) => w.id === swarmWsId);
    expect(instance?.path).toBe(PROJECT);
    expect(instance?.name).toMatch(/\(swarm\)$/);

    // The launched pane is pinned to that instance (addPane's 6th arg).
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
    expect(addPaneMock.mock.calls[0][5]).toBe(swarmWsId);
  });

  it('a force-reload does not clobber a same-path swarm that has a starting agent mid-launch', async () => {
    // Simulate the workspace-change force-reload firing while a launch is in flight.
    seed([agent('root', [], 'starting', { terminalId: undefined })]);
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_swarm_state'
        ? Promise.resolve(JSON.stringify({ swarmId: 'x', agents: [], status: 'idle' }))
        : Promise.resolve(undefined),
    );

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    // The in-flight 'starting' agent survives - disk (empty/idle) did not overwrite it.
    expect(getAgent('root').status).toBe('starting');
    expect(invokeMock).not.toHaveBeenCalledWith('read_swarm_state', expect.anything());
  });
});

describe('postToMailbox (P2 composer)', () => {
  it('appends the operator note under existing mailbox content without clobbering it', async () => {
    let written: string | undefined;
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_mailbox_file') return Promise.resolve('agent wrote this earlier');
      if (cmd === 'write_mailbox_file') {
        written = args.content as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const next = await useSwarmStore.getState().postToMailbox(PROJECT, 'a', '  do the thing  ');

    expect(written).toBe(next);
    expect(next.startsWith('agent wrote this earlier')).toBe(true);
    expect(next).toContain('**Operator message:**');
    expect(next).toContain('do the thing'); // trimmed
    expect(next).not.toContain('  do the thing  ');
  });

  it('starts a fresh mailbox when none exists yet', async () => {
    let written: string | undefined;
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_mailbox_file') return Promise.reject(new Error('not found'));
      if (cmd === 'write_mailbox_file') {
        written = args.content as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });

    const next = await useSwarmStore.getState().postToMailbox(PROJECT, 'a', 'hello');

    expect(written).toBe(next);
    expect(next.startsWith('---')).toBe(true); // no leading blank lines on a fresh mailbox
    expect(next).toContain('hello');
  });

  it('is a no-op for a blank message', async () => {
    invokeMock.mockClear();
    const next = await useSwarmStore.getState().postToMailbox(PROJECT, 'a', '   ');
    expect(next).toBe('');
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('loadSwarmState cross-project signal recovery (P13)', () => {
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

  const mockDisk = (agents: SwarmAgent[]) =>
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'read_swarm_state') return Promise.resolve(diskState(agents, 'running'));
      if (cmd === 'read_project_file') return Promise.reject(new Error('not found'));
      return Promise.resolve(undefined);
    });

  it('completes an agent whose scoped done marker arrived while another project was open', async () => {
    terminalSessions['pane-a'] = { id: 'pane-a' };
    signalTails['pane-a'] = 'final output\n[AGENT_DONE:tok1234]\n';
    mockDisk([agent('a', [], 'running', { terminalId: 'pane-a', marker: 'tok1234' })]);

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    await vi.waitFor(() => expect(getAgent('a').status).toBe('done'));
    expect(useSwarmStore.getState().status).toBe('completed');
  });

  it('a recovered completion advances waiting dependents', async () => {
    terminalSessions['pane-a'] = { id: 'pane-a' };
    signalTails['pane-a'] = '[AGENT_DONE:tok1234]\n';
    mockDisk([
      agent('a', [], 'running', { terminalId: 'pane-a', marker: 'tok1234' }),
      agent('b', ['a'], 'waiting'),
    ]);

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    await vi.waitFor(() => expect(getAgent('a').status).toBe('done'));
    await vi.waitFor(() => expect(getAgent('b').status).toBe('running'));
  });

  it('applies a pending exit recorded while the project was not loaded', async () => {
    terminalSessions['pane-b'] = { id: 'pane-b' };
    recordPendingAgentExit(PROJECT, 'pane-b', 0);
    mockDisk([agent('b', [], 'running', { terminalId: 'pane-b', marker: 'tok9999' })]);

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    await vi.waitFor(() => expect(getAgent('b').status).toBe('review'));
    expect(getAgent('b').statusReason).toMatch(/without a completion signal/i);
  });

  it('the marker tail wins over a pending exit when both exist', async () => {
    terminalSessions['pane-c'] = { id: 'pane-c' };
    signalTails['pane-c'] = '[AGENT_FAILED:tok5555]\n';
    recordPendingAgentExit(PROJECT, 'pane-c', 0);
    mockDisk([agent('c', [], 'running', { terminalId: 'pane-c', marker: 'tok5555' })]);

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    await vi.waitFor(() => expect(getAgent('c').status).toBe('failed'));
  });

  it('a bare marker from another pane cannot complete a scoped agent on recovery', async () => {
    terminalSessions['pane-d'] = { id: 'pane-d' };
    signalTails['pane-d'] = '[AGENT_DONE]\n'; // unscoped — must not advance a marker-scoped agent
    mockDisk([agent('d', [], 'running', { terminalId: 'pane-d', marker: 'tok7777' })]);

    await useSwarmStore.getState().loadSwarmState(PROJECT, true);

    expect(getAgent('d').status).toBe('running');
  });
});
