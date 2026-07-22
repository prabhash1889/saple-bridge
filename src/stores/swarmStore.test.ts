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
// Panes whose PTY child exited (Phase 3 coordinator crash detection reads this).
const exitedPanes = vi.hoisted(() => ({} as Record<string, boolean>));
vi.mock('./terminalStore', () => ({
  useTerminalStore: {
    getState: () => ({
      addPane: addPaneMock,
      removePane: removePaneMock,
      updateSession: vi.fn(),
      getMaxPaneLimit: () => maxPaneLimitRef.value,
      sessions: terminalSessions,
      exitedPanes,
      subscribeOutput: vi.fn(() => () => {}),
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
import { hashAcceptanceOutput } from '../lib/swarmDigest';
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
    resolvedWorkerRequests: [],
  });
};

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  addPaneMock.mockReset().mockResolvedValue('pane-1');
  removePaneMock.mockReset().mockResolvedValue(undefined);
  maxPaneLimitRef.value = 16;
  for (const key of Object.keys(terminalSessions)) delete terminalSessions[key];
  for (const key of Object.keys(signalTails)) delete signalTails[key];
  for (const key of Object.keys(exitedPanes)) delete exitedPanes[key];
  useSwarmStore.setState({
    digestLog: [],
    coordinatorCrashes: 0,
    lastDigestWave: 0,
    wave: 1,
    maxWaves: 3,
    coordinatorState: 'idle',
    plan: null,
    acceptanceStatus: 'idle',
    lastAcceptanceOutput: null,
    lastAcceptanceFailureHash: null,
    identicalAcceptanceFailures: 0,
    escalation: null,
  });
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

describe('reworkAgent (P4 bounded review-and-rework)', () => {
  it('appends feedback to the mailbox, bumps attempt, and relaunches within budget', async () => {
    let mailbox = '';
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_mailbox_file') return Promise.resolve(mailbox);
      if (cmd === 'write_mailbox_file') {
        mailbox = args.content as string;
        return Promise.resolve(undefined);
      }
      return Promise.resolve(undefined);
    });
    // Default budget (maxAttempts 1 = one approval-free rework): the first reject relaunches freely.
    seed([agent('builder', [], 'review')]);

    const result = await useSwarmStore.getState().reworkAgent(PROJECT, 'builder', 'fix the null check');

    expect(result.ok).toBe(true);
    expect(getAgent('builder').attempt).toBe(2);
    expect(getAgent('builder').lastReviewFeedback).toBe('fix the null check');
    expect(mailbox).toContain('fix the null check');
    // Relaunch spawns a fresh pane.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });

  it('refuses to exceed the rework budget without force, then relaunches when forced', async () => {
    // attempt 2 = the initial run plus one rework, so the budget of 1 is spent.
    seed([agent('builder', [], 'review', { attempt: 2, maxAttempts: 1 })]);

    const blocked = await useSwarmStore.getState().reworkAgent(PROJECT, 'builder', 'again');
    expect(blocked).toEqual({ ok: false, limitReached: true, maxAttempts: 1 });
    // Nothing launched, attempt untouched — the cap can't be bypassed by repeated rejects.
    expect(addPaneMock).not.toHaveBeenCalled();
    expect(getAgent('builder').attempt).toBe(2);

    const forced = await useSwarmStore.getState().reworkAgent(PROJECT, 'builder', 'again', true);
    expect(forced.ok).toBe(true);
    expect(getAgent('builder').attempt).toBe(3);
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });
});

describe('worker requests (P6 approved dynamic workers)', () => {
  const requestsFile = (reqs: unknown[]) =>
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'read_project_file') return Promise.resolve(JSON.stringify(reqs));
      return Promise.resolve(undefined);
    });

  it('returns well-formed pending requests and drops malformed / already-resolved ones', async () => {
    seed([agent('coord', [], 'running')]);
    useSwarmStore.setState({ resolvedWorkerRequests: ['done-1'] });
    requestsFile([
      { id: 'req-1', mission: 'fix mobile layout', role: 'builder', provider: 'codex', model: 'default', dependsOn: ['coord'] },
      { id: 'done-1', mission: 'already handled' }, // resolved -> filtered
      { mission: 'no id' }, // malformed -> dropped
      { id: 'req-2' }, // no mission -> dropped
      { id: 'req-1', mission: 'duplicate id' }, // dup id -> collapsed
    ]);

    const pending = await useSwarmStore.getState().loadWorkerRequests(PROJECT);

    expect(pending.map((r) => r.id)).toEqual(['req-1']);
    expect(pending[0].role).toBe('builder');
    expect(pending[0].dependsOn).toEqual(['coord']);
  });

  it('approving inserts a worker through the scheduler and marks the request resolved', async () => {
    seed([agent('coord', [], 'done')]);
    const req = { id: 'req-1', role: 'builder' as const, provider: 'codex' as const, model: 'default', mission: 'do it', dependsOn: ['coord'] };

    await useSwarmStore.getState().resolveWorkerRequest(PROJECT, req, true);

    const agents = useSwarmStore.getState().activeAgents;
    expect(agents).toHaveLength(2);
    const worker = agents.find((a) => a.id !== 'coord')!;
    expect(worker.systemPrompt).toBe('do it');
    expect(worker.dependencies).toEqual(['coord']); // known dep kept
    expect(useSwarmStore.getState().resolvedWorkerRequests).toContain('req-1');
    // Deps are all done, so the scheduler launched it.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });

  it('drops unknown dependencies and is idempotent for an already-resolved id', async () => {
    seed([agent('coord', [], 'running')]);
    const req = { id: 'req-1', role: 'builder' as const, model: 'default', mission: 'm', dependsOn: ['ghost'] };

    await useSwarmStore.getState().resolveWorkerRequest(PROJECT, req, true);
    const worker = useSwarmStore.getState().activeAgents.find((a) => a.id !== 'coord')!;
    expect(worker.dependencies).toEqual([]); // unknown 'ghost' filtered -> launches immediately
    expect(worker.status === 'idle' || worker.status === 'starting' || worker.status === 'running').toBe(true);

    // A second resolve with the same id must not add a duplicate worker.
    await useSwarmStore.getState().resolveWorkerRequest(PROJECT, req, true);
    expect(useSwarmStore.getState().activeAgents).toHaveLength(2);
  });

  it('rejecting resolves the id without inserting a worker', async () => {
    seed([agent('coord', [], 'running')]);
    const req = { id: 'req-9', role: 'builder' as const, model: 'default', mission: 'm', dependsOn: [] };

    await useSwarmStore.getState().resolveWorkerRequest(PROJECT, req, false);

    expect(useSwarmStore.getState().activeAgents).toHaveLength(1);
    expect(useSwarmStore.getState().resolvedWorkerRequests).toContain('req-9');
    expect(addPaneMock).not.toHaveBeenCalled();
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

describe('startSwarm + plan intake (Phase 2)', () => {
  const mockPlan = (plan: unknown) =>
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_project_file' && args.filePath === '.saple/swarm/plan.json') {
        return Promise.resolve(JSON.stringify(plan));
      }
      return Promise.resolve(undefined);
    });

  it('seeds a single coordinator and launches it', async () => {
    await useSwarmStore.getState().startSwarm(PROJECT, 'ship the feature', { provider: 'claude' });

    const agents = useSwarmStore.getState().activeAgents;
    expect(agents).toHaveLength(1);
    expect(agents[0].role).toBe('coordinator');
    expect(agents[0].marker).toBeTruthy();
    expect(useSwarmStore.getState().mission).toBe('ship the feature');
    expect(useSwarmStore.getState().status).toBe('running');
    // The coordinator has no dependencies, so the scheduler launches it immediately.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });

  it('materializes plan tasks with mapped dependencies and is idempotent on re-ingest', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    mockPlan({
      version: 2,
      acceptance: { command: 'npm test' },
      // 'build' depends on a sibling that appears BEFORE it here, but the mapping must resolve
      // regardless of order (parsePlan preserves input order, not topological order).
      tasks: [
        { id: 'design', mission: 'design it', role: 'builder' },
        { id: 'build', mission: 'build it', role: 'builder', dependsOn: ['design'] },
      ],
    });

    await useSwarmStore.getState().ingestPlan(PROJECT);

    const agents = useSwarmStore.getState().activeAgents;
    const design = agents.find((a) => a.taskId === 'design')!;
    const build = agents.find((a) => a.taskId === 'build')!;
    expect(design).toBeTruthy();
    expect(build).toBeTruthy();
    expect(build.dependencies).toEqual([design.id]); // task id -> agent id
    expect(build.status).toBe('waiting'); // design not done yet
    expect(useSwarmStore.getState().appliedPlanTaskIds).toEqual(['design', 'build']);

    // Re-ingesting the same plan adds nothing (dedup on appliedPlanTaskIds).
    await useSwarmStore.getState().ingestPlan(PROJECT);
    expect(useSwarmStore.getState().activeAgents.filter((a) => a.taskId)).toHaveLength(2);
  });

  it('drops cyclic and malformed tasks via the sanitizer', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    mockPlan({
      version: 2,
      tasks: [
        { id: 'a', mission: 'a', role: 'builder', dependsOn: ['b'] },
        { id: 'b', mission: 'b', role: 'builder', dependsOn: ['a'] }, // cycle -> both dropped
        { mission: 'no id' }, // malformed -> dropped
        { id: 'ok', mission: 'standalone', role: 'builder' },
      ],
    });

    await useSwarmStore.getState().ingestPlan(PROJECT);

    expect(useSwarmStore.getState().appliedPlanTaskIds).toEqual(['ok']);
  });

  it('a coordinator that produced a plan completes normally and its workers exist', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    mockPlan({ version: 2, tasks: [{ id: 't1', mission: 'do the thing', role: 'builder' }] });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'coordinator', 'done');

    expect(getAgent('coordinator').status).toBe('done');
    expect(useSwarmStore.getState().activeAgents.some((a) => a.taskId === 't1')).toBe(true);
  });

  it('promotes a clean-exit coordinator review to done when it produced a plan', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    mockPlan({ version: 2, tasks: [{ id: 't1', mission: 'do', role: 'builder' }] });

    // Clean exit without an AGENT_DONE marker parks the agent in 'review' via the exit fallback;
    // for a coordinator that already planned, that must resolve to done, not sit blocking completion.
    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'coordinator', 'review');

    expect(getAgent('coordinator').status).toBe('done');
  });

  it('a coordinator that never produced a valid plan is parked in review for retry', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_project_file' ? Promise.reject(new Error('no plan')) : Promise.resolve(undefined),
    );

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'coordinator', 'done');

    expect(getAgent('coordinator').status).toBe('review');
    expect(getAgent('coordinator').statusReason).toMatch(/retry planning/i);
  });
});

describe('live coordinator (Phase 3)', () => {
  const coordinator = (extra: Partial<SwarmAgent> = {}) =>
    agent('coordinator', [], 'running', {
      role: 'coordinator',
      provider: 'claude',
      terminalId: 'coord-pane',
      marker: 'tokcccc',
      ...extra,
    });

  it('wave completion records a digest and defers swarm completion until the coordinator reacts', async () => {
    seed([coordinator(), agent('worker', [], 'done', { taskId: 't1' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: ['t1'], wave: 1, lastDigestWave: 0 });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(useSwarmStore.getState().lastDigestWave).toBe(1);
    await vi.waitFor(() => expect(useSwarmStore.getState().digestLog).toHaveLength(1));
    expect(useSwarmStore.getState().digestLog[0]).toContain('[Bridge digest] Wave 1');
    expect(useSwarmStore.getState().digestLog[0]).toContain('t1 (worker)');
    // The swarm did NOT complete: the coordinator gets the results first.
    expect(useSwarmStore.getState().status).toBe('running');
    // No live pane watch is armed in tests, so delivery falls back to a digest-relaunch.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });

  it('after the digest wave is delivered, an all-done roster completes the swarm', async () => {
    seed([coordinator({ status: 'done' }), agent('worker', [], 'done', { taskId: 't1' })]);
    useSwarmStore.setState({ wave: 1, lastDigestWave: 1 });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(useSwarmStore.getState().status).toBe('completed');
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('a terminally failed worker records a failure digest without relaunching the coordinator', async () => {
    seed([
      coordinator(),
      agent('w1', [], 'running', { taskId: 't1', terminalId: 'w1-pane' }),
      agent('w2', [], 'running', { taskId: 't2', terminalId: 'w2-pane' }),
    ]);

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'w1', 'failed');

    await vi.waitFor(() => expect(useSwarmStore.getState().digestLog).toHaveLength(1));
    expect(useSwarmStore.getState().digestLog[0]).toContain('a task failed terminally');
    // Injection-only delivery: no pane watch armed, but a failure must never relaunch.
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('a live coordinator crash mid-swarm auto-relaunches once with the digest prompt', async () => {
    exitedPanes['coord-pane'] = true;
    seed([coordinator(), agent('worker', [], 'running', { taskId: 't1', terminalId: 'w-pane' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: ['t1'] });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_project_file' ? Promise.reject(new Error('nope')) : Promise.resolve(undefined),
    );

    // Exit fallback shape: the pane died without a marker while a worker is still running.
    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'coordinator', 'review');

    expect(useSwarmStore.getState().coordinatorCrashes).toBe(1);
    expect(useSwarmStore.getState().digestLog.some((d) => d.includes('ended unexpectedly'))).toBe(true);
    // Relaunched, not parked: a fresh pane spawns for the coordinator.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
    expect(getAgent('coordinator').status).not.toBe('review');
  });

  it('a second crash escalates to a human instead of relaunching again', async () => {
    exitedPanes['coord-pane'] = true;
    seed([coordinator(), agent('worker', [], 'running', { taskId: 't1', terminalId: 'w-pane' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: ['t1'], coordinatorCrashes: 1 });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_project_file' ? Promise.reject(new Error('nope')) : Promise.resolve(undefined),
    );

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'coordinator', 'review');

    expect(getAgent('coordinator').status).toBe('review');
    expect(getAgent('coordinator').statusReason).toMatch(/crashed twice/i);
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('new plan tasks after a delivered wave digest open the next wave', async () => {
    seed([coordinator()]);
    useSwarmStore.setState({ appliedPlanTaskIds: ['t1'], wave: 1, lastDigestWave: 1 });
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_project_file' && args.filePath === '.saple/swarm/plan.json') {
        return Promise.resolve(
          JSON.stringify({ version: 2, tasks: [{ id: 't2', mission: 'repair it', role: 'builder' }] }),
        );
      }
      return Promise.resolve(undefined);
    });

    await useSwarmStore.getState().ingestPlan(PROJECT);

    expect(useSwarmStore.getState().wave).toBe(2);
    expect(useSwarmStore.getState().appliedPlanTaskIds).toEqual(['t1', 't2']);
  });
});

describe('acceptance and repair waves (Phase 5)', () => {
  const PLAN = { version: 2, acceptance: { command: 'npm test' }, tasks: [] };

  // Coordinator + one finished worker, wave digest not yet delivered - the scan's wave branch.
  const seedAcceptanceWave = () => {
    seed([
      agent('coordinator', [], 'running', { role: 'coordinator', provider: 'claude', terminalId: 'coord-pane', marker: 'tokcccc' }),
      agent('worker', [], 'done', { taskId: 't1' }),
    ]);
    useSwarmStore.setState({ plan: PLAN, appliedPlanTaskIds: ['t1'], wave: 1, lastDigestWave: 0 });
  };

  // run_acceptance_command resolves with the given result; project-file reads miss (no outcomes).
  const mockAcceptance = (result: { exitCode: number | null; output: string; timedOut: boolean }) => {
    const runs: Array<Record<string, unknown>> = [];
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'run_acceptance_command') {
        runs.push(args);
        return Promise.resolve(result);
      }
      if (cmd === 'read_project_file') return Promise.reject(new Error('missing'));
      return Promise.resolve(undefined);
    });
    return runs;
  };

  it('a fully-approved wave runs the acceptance command; a pass records the synthesis digest', async () => {
    seedAcceptanceWave();
    const runs = mockAcceptance({ exitCode: 0, output: 'all green', timedOut: false });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().acceptanceStatus).toBe('passed'));
    expect(runs[0].commandStr).toBe('npm test');
    await vi.waitFor(() => expect(useSwarmStore.getState().digestLog).toHaveLength(1));
    expect(useSwarmStore.getState().digestLog[0]).toContain('acceptance command passed');
    // No plain wave digest was sent - acceptance replaced it.
    expect(useSwarmStore.getState().digestLog[0]).not.toContain('all worker tasks have finished');
    // The swarm did NOT complete: the coordinator writes the final report first.
    expect(useSwarmStore.getState().status).toBe('running');
  });

  it('completes the swarm only after acceptance passed', async () => {
    seed([
      agent('coordinator', [], 'done', { role: 'coordinator' }),
      agent('worker', [], 'done', { taskId: 't1' }),
    ]);
    useSwarmStore.setState({ plan: PLAN, wave: 1, lastDigestWave: 1, acceptanceStatus: 'passed' });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    expect(useSwarmStore.getState().status).toBe('completed');
  });

  it('a failing acceptance sends a repair digest and keeps the swarm running', async () => {
    seedAcceptanceWave();
    mockAcceptance({ exitCode: 1, output: 'FAIL: expected 2 got 3', timedOut: false });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().acceptanceStatus).toBe('failed'));
    expect(useSwarmStore.getState().identicalAcceptanceFailures).toBe(1);
    await vi.waitFor(() => expect(useSwarmStore.getState().digestLog).toHaveLength(1));
    expect(useSwarmStore.getState().digestLog[0]).toContain('FAILED');
    expect(useSwarmStore.getState().digestLog[0]).toContain('expected 2 got 3');
    expect(useSwarmStore.getState().status).toBe('running');
    expect(useSwarmStore.getState().escalation).toBeNull();
  });

  it('two consecutive identical failures short-circuit to escalation', async () => {
    seedAcceptanceWave();
    useSwarmStore.setState({
      lastAcceptanceFailureHash: hashAcceptanceOutput('FAIL: same wall'),
      identicalAcceptanceFailures: 1,
      lastAcceptanceOutput: 'FAIL: same wall',
    });
    mockAcceptance({ exitCode: 1, output: 'FAIL: same wall', timedOut: false });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().status).toBe('failed'));
    const escalation = useSwarmStore.getState().escalation!;
    expect(escalation.reason).toBe('repeated_failure');
    expect(escalation.wavesAttempted).toBe(1);
    expect(escalation.maxWaves).toBe(3);
    expect(escalation.acceptanceCommand).toBe('npm test');
    expect(escalation.failureOutput).toContain('same wall');
    expect(escalation.proposedTasks).toEqual([]);
    // The structured report is also written for the human.
    expect(invokeMock).toHaveBeenCalledWith(
      'write_project_file',
      expect.objectContaining({ filePath: '.saple/swarm/escalation.json' }),
    );
  });

  it('an acceptance failure at the wave budget escalates instead of looping', async () => {
    seedAcceptanceWave();
    useSwarmStore.setState({ wave: 3, maxWaves: 3, lastDigestWave: 2 });
    mockAcceptance({ exitCode: 1, output: 'FAIL: a fresh failure', timedOut: false });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().status).toBe('failed'));
    expect(useSwarmStore.getState().escalation?.reason).toBe('max_waves');
    // The failure digest was never sent - no repair wave past the budget.
    expect(useSwarmStore.getState().digestLog).toHaveLength(0);
  });

  it('a coordinator that finishes after a failed acceptance without repair tasks escalates', async () => {
    seed([
      agent('coordinator', [], 'done', { role: 'coordinator' }),
      agent('worker', [], 'done', { taskId: 't1' }),
    ]);
    useSwarmStore.setState({
      plan: PLAN,
      wave: 1,
      lastDigestWave: 1,
      acceptanceStatus: 'failed',
      lastAcceptanceOutput: 'FAIL',
    });
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'read_project_file' ? Promise.reject(new Error('missing')) : Promise.resolve(undefined),
    );

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().status).toBe('failed'));
    expect(useSwarmStore.getState().escalation?.reason).toBe('no_new_tasks');
  });

  it('a timed-out acceptance run counts as a failure, not a pass', async () => {
    seedAcceptanceWave();
    mockAcceptance({ exitCode: 0, output: 'hung forever', timedOut: true });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().acceptanceStatus).toBe('failed'));
  });

  it('a wave without an acceptance command keeps the plain wave digest', async () => {
    seedAcceptanceWave();
    useSwarmStore.setState({ plan: { version: 2, acceptance: null, tasks: [] } });
    const runs = mockAcceptance({ exitCode: 0, output: '', timedOut: false });

    await useSwarmStore.getState().checkAndRunNextAgents(PROJECT);

    await vi.waitFor(() => expect(useSwarmStore.getState().digestLog).toHaveLength(1));
    expect(useSwarmStore.getState().digestLog[0]).toContain('all worker tasks have finished');
    expect(runs).toHaveLength(0);
  });
});

describe('automated review gate (Phase 4)', () => {
  const mockSwarmFiles = (files: Record<string, unknown>) =>
    invokeMock.mockImplementation((cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'read_project_file') {
        const content = files[args.filePath as string];
        if (content === undefined) return Promise.reject(new Error('missing'));
        return Promise.resolve(JSON.stringify(content));
      }
      return Promise.resolve(undefined);
    });

  // A reviewed task sitting done at its gate, with its reviewer about to deliver a verdict and a
  // dependent waiting behind both.
  const seedGate = (targetStatus: AgentStatus = 'done', targetExtra: Partial<SwarmAgent> = {}) => {
    seed([
      agent('builder-1', [], targetStatus, { taskId: 't1', ...targetExtra }),
      agent('reviewer-1', ['builder-1'], 'running', {
        role: 'reviewer',
        reviewTaskId: 't1',
        reviewTargetAgentId: 'builder-1',
        terminalId: 'rev-pane',
      }),
      agent('dep-1', ['builder-1', 'reviewer-1'], 'waiting'),
    ]);
    useSwarmStore.setState({ autonomy: 'gated', appliedPlanTaskIds: ['t1'] });
  };

  it('a review:true plan task materializes a reviewer whose gate holds dependents', async () => {
    seed([agent('coordinator', [], 'running', { role: 'coordinator' })]);
    useSwarmStore.setState({ appliedPlanTaskIds: [], plan: null });
    mockSwarmFiles({
      '.saple/swarm/plan.json': {
        version: 2,
        tasks: [
          { id: 'build', mission: 'build it', role: 'builder', review: true },
          { id: 'ship', mission: 'ship it', role: 'builder', dependsOn: ['build'] },
        ],
      },
    });

    await useSwarmStore.getState().ingestPlan(PROJECT);

    const agents = useSwarmStore.getState().activeAgents;
    const builder = agents.find((a) => a.taskId === 'build')!;
    const reviewer = agents.find((a) => a.reviewTaskId === 'build')!;
    const ship = agents.find((a) => a.taskId === 'ship')!;
    expect(reviewer.role).toBe('reviewer');
    expect(reviewer.reviewTargetAgentId).toBe(builder.id);
    expect(reviewer.dependencies).toEqual([builder.id]);
    expect(reviewer.status).toBe('waiting');
    // "done" for a reviewed task means built AND reviewed: dependents wait on the whole gate.
    expect([...ship.dependencies].sort()).toEqual([builder.id, reviewer.id].sort());
  });

  it('an approve verdict unblocks dependents with zero human clicks', async () => {
    seedGate();
    mockSwarmFiles({ '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'approve' } });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'reviewer-1', 'done');

    expect(getAgent('builder-1').status).toBe('done');
    expect(getAgent('builder-1').lastVerdict).toBe('approve');
    // The dependent's gate (builder + reviewer) is fully done, so the scheduler launches it.
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled());
  });

  it('a reject verdict auto-reworks the builder with feedback and re-arms the reviewer', async () => {
    seedGate();
    mockSwarmFiles({
      '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'reject', feedback: 'wrong storage' },
    });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'reviewer-1', 'done');

    const builder = getAgent('builder-1');
    expect(builder.attempt).toBe(2);
    expect(builder.lastReviewFeedback).toBe('wrong storage');
    expect(builder.lastVerdict).toBe('reject');
    expect(builder.taskId).toBe('t1'); // the plan-task link survives the relaunch
    // The reviewer drops back behind the new attempt instead of staying stale-done.
    expect(getAgent('reviewer-1').status).toBe('waiting');
    expect(getAgent('dep-1').status).toBe('waiting');
    await vi.waitFor(() => expect(addPaneMock).toHaveBeenCalled()); // builder relaunched
  });

  it('a reject past the rework budget parks the builder for a human instead of looping', async () => {
    seedGate('done', { attempt: 2, maxAttempts: 1 });
    mockSwarmFiles({
      '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'reject', feedback: 'still wrong' },
    });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'reviewer-1', 'done');

    expect(getAgent('builder-1').status).toBe('review');
    expect(getAgent('builder-1').statusReason).toMatch(/rework budget/i);
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('a garbage verdict parks the reviewed task for a human — never guesses', async () => {
    seedGate();
    mockSwarmFiles({ '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'maybe' } });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'reviewer-1', 'done');

    expect(getAgent('builder-1').status).toBe('review');
    expect(getAgent('builder-1').statusReason).toMatch(/no readable verdict/i);
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('manual autonomy records the reject but leaves the transition to a human', async () => {
    seedGate();
    useSwarmStore.setState({ autonomy: 'manual' });
    mockSwarmFiles({
      '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'reject', feedback: 'nope' },
    });

    await useSwarmStore.getState().updateAgentStatus(PROJECT, 'reviewer-1', 'done');

    expect(getAgent('builder-1').status).toBe('review');
    expect(getAgent('builder-1').lastVerdict).toBe('reject');
    expect(getAgent('builder-1').attempt).toBeUndefined(); // no auto-rework in manual
    expect(addPaneMock).not.toHaveBeenCalled();
  });

  it('the lenient watcher path never acts while the reviewer is still running', async () => {
    seedGate();
    mockSwarmFiles({
      '.saple/swarm/verdicts/t1.json': { taskId: 't1', verdict: 'reject', feedback: 'early write' },
    });

    // Watcher event fires before the reviewer's completion marker: no strict flag, reviewer live.
    await useSwarmStore.getState().ingestVerdict(PROJECT, 't1');

    expect(getAgent('builder-1').status).toBe('done');
    expect(getAgent('builder-1').attempt).toBeUndefined();
    expect(addPaneMock).not.toHaveBeenCalled();
  });
});
