import { describe, it, expect, vi, beforeEach } from 'vitest';

// Unit tests for terminalSwarmBridge: raw transport events in, swarm/Kanban transitions out.
// The stores and notification helper are mocked; agentSignals stays real so marker matching
// (bare vs scoped, line anchoring) is exercised genuinely.

const notifyTaskReadyForReview = vi.hoisted(() => vi.fn());
vi.mock('./desktopNotifications', () => ({
  notifyTaskReadyForReview,
}));

const projectRef = vi.hoisted(() => ({
  currentProjectPath: '/proj' as string | null,
}));
vi.mock('../stores/projectStore', () => ({
  useProjectStore: { getState: () => projectRef },
}));

const kanbanState = vi.hoisted(() => ({
  loadedProjectPath: '/proj' as string | null,
  tasks: [] as Array<{ id: string; title?: string; column: string; terminalId?: string }>,
  updateTask: vi.fn(),
}));
const recordPendingTaskReview = vi.hoisted(() => vi.fn());
vi.mock('../stores/kanbanStore', () => ({
  useKanbanStore: { getState: () => kanbanState },
  recordPendingTaskReview,
}));

const swarmState = vi.hoisted(() => ({
  loadedProjectPath: '/proj' as string | null,
  activeAgents: [] as Array<{ id: string; status: string; terminalId?: string; marker?: string }>,
  updateAgentStatus: vi.fn(),
  ingestPlan: vi.fn(),
}));
const recordPendingAgentExit = vi.hoisted(() => vi.fn());
vi.mock('../stores/swarmStore', () => ({
  useSwarmStore: { getState: () => swarmState },
  recordPendingAgentExit,
}));

// Terminal store stand-in: captures the bridge's subscription, serves fixture signal tails and
// sessions, and records review-badge requests.
const terminalRef = vi.hoisted(() => {
  return {
    sessions: {} as Record<string, { workspacePath?: string } | undefined>,
    tails: {} as Record<string, string>,
    requestReview: vi.fn(),
    capturedHandler: null as ((event: unknown) => void) | null,
  };
});
vi.mock('../stores/terminalStore', () => ({
  useTerminalStore: { getState: () => terminalRef },
  getPaneSignalTail: (paneId: string) => terminalRef.tails[paneId] ?? '',
  subscribeRawTerminalEvents: (listener: (event: unknown) => void) => {
    terminalRef.capturedHandler = listener;
    return () => {
      terminalRef.capturedHandler = null;
    };
  },
}));

import { startTerminalSwarmBridge } from './terminalSwarmBridge';
import { exitFallbackTransition } from './agentSignals';

const PANE = 'pane-1';

const emit = (event: unknown) => terminalRef.capturedHandler?.(event);

const outputEvent = (data: string, paneId = PANE) =>
  emit({ kind: 'output', paneId, data });

const setTail = (tail: string, paneId = PANE) => {
  // Mirrors terminalStore: the rolling tail holds the pane's recent raw output.
  terminalRef.tails[paneId] = tail;
};

const agent = (id: string, extra: Partial<{ status: string; terminalId: string; marker: string }> = {}) => ({
  status: 'running',
  terminalId: PANE,
  ...extra,
  id,
});

beforeEach(() => {
  startTerminalSwarmBridge();
  notifyTaskReadyForReview.mockReset();
  kanbanState.updateTask.mockReset();
  recordPendingTaskReview.mockReset();
  swarmState.updateAgentStatus.mockReset();
  swarmState.ingestPlan.mockReset();
  recordPendingAgentExit.mockReset();
  terminalRef.requestReview.mockReset();
  kanbanState.loadedProjectPath = '/proj';
  kanbanState.tasks = [];
  swarmState.loadedProjectPath = '/proj';
  swarmState.activeAgents = [];
  projectRef.currentProjectPath = '/proj';
  terminalRef.sessions = {};
  terminalRef.tails = {};
});

describe('output -> review + kanban transitions', () => {
  it('ignores ordinary output without marker characters', () => {
    setTail('npm install\nadded 42 packages in 3s\n');
    outputEvent('added 42 packages in 3s\n');

    expect(terminalRef.requestReview).not.toHaveBeenCalled();
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
    expect(recordPendingTaskReview).not.toHaveBeenCalled();
  });

  it('does not reach for swarm state on bracket-typing that is no marker', () => {
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1' }));
    setTail('const arr[0] = items;\n');
    outputEvent('const arr[0] = items;\n');

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
    expect(swarmState.ingestPlan).not.toHaveBeenCalled();
  });

  it('moves a linked task to review and badges the pane on a bare review marker', () => {
    kanbanState.tasks.push({ id: 'task-1', title: 'Fix login flow', column: 'progress', terminalId: PANE });
    setTail('building...\n[AGENT_REVIEW]\n');
    outputEvent('[AGENT_REVIEW]\n');

    expect(terminalRef.requestReview).toHaveBeenCalledWith(PANE);
    expect(kanbanState.updateTask).toHaveBeenCalledWith('/proj', 'task-1', { column: 'review' });
    expect(notifyTaskReadyForReview).toHaveBeenCalledWith('Fix login flow');
  });

  it('queues a pending task review when another project is loaded', () => {
    kanbanState.loadedProjectPath = '/other';
    kanbanState.tasks.push({ id: 'task-1', column: 'progress', terminalId: PANE });
    setTail('## REVIEW REQUIRED\n');
    outputEvent('## REVIEW REQUIRED\n');

    expect(recordPendingTaskReview).toHaveBeenCalledWith('/proj', PANE);
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
  });

  it('skips kanban handling entirely when no project path resolves', () => {
    projectRef.currentProjectPath = null;
    terminalRef.sessions[PANE] = undefined;
    setTail('[AGENT_REVIEW]\n');
    outputEvent('[AGENT_REVIEW]\n');

    expect(terminalRef.requestReview).toHaveBeenCalledWith(PANE); // pane badge still flips
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
    expect(recordPendingTaskReview).not.toHaveBeenCalled();
  });

  it('routes by the pane workspace path over the active project (P13)', () => {
    terminalRef.sessions[PANE] = { workspacePath: '/pane-proj' };
    projectRef.currentProjectPath = '/active-proj';
    kanbanState.loadedProjectPath = '/active-proj';
    kanbanState.tasks.push({ id: 'task-9', column: 'progress', terminalId: PANE });
    setTail('[AGENT_REVIEW]\n');
    outputEvent('[AGENT_REVIEW]\n');

    // The pane's own project is not loaded, so the move is queued against it - never applied
    // to whichever project happens to be active.
    expect(recordPendingTaskReview).toHaveBeenCalledWith('/pane-proj', PANE);
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
  });
});

describe('output -> swarm transitions', () => {
  it('advances the linked agent on its scoped done marker', () => {
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1' }));
    setTail('finished up\n[AGENT_DONE:tok1]\n');
    outputEvent('[AGENT_DONE:tok1]\n');

    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', 'done');
    expect(terminalRef.requestReview).not.toHaveBeenCalled();
  });

  it('never advances an agent on another agent scoped marker or the bare form', () => {
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1', status: 'running' }));
    setTail('[AGENT_DONE:tok2]\n[AGENT_DONE]\n');
    outputEvent('[AGENT_DONE:tok2]\n');

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('mirrors the review badge on a scoped review marker and transitions to review', () => {
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1' }));
    setTail('[REVIEW_REQUESTED:tok1]\n');
    outputEvent('[REVIEW_REQUESTED:tok1]\n');

    expect(terminalRef.requestReview).toHaveBeenCalledWith(PANE);
    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', 'review');
  });

  it('triggers plan intake on the coordinator plan marker', () => {
    swarmState.activeAgents.push(agent('coord', { marker: 'tokC' }));
    setTail('[PLAN_READY:tokC]\n');
    outputEvent('[PLAN_READY:tokC]\n');

    expect(swarmState.ingestPlan).toHaveBeenCalledWith('/proj');
    // Plan markers alone are not status transitions.
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('emits a single plan intake even when several plan markers are present', () => {
    swarmState.activeAgents.push(agent('coord', { marker: 'tokC' }));
    setTail('[PLAN_READY:tokC]\n[PLAN_UPDATED:tokC]\n');
    outputEvent('');

    expect(swarmState.ingestPlan).toHaveBeenCalledTimes(1);
  });

  it('skips the transition when the agent already sits in the target status', () => {
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1', status: 'done' }));
    setTail('[AGENT_DONE:tok1]\n');
    outputEvent('[AGENT_DONE:tok1]\n');

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('ignores markers from panes with no linked agent', () => {
    swarmState.activeAgents.push({ id: 'a1', status: 'running', terminalId: 'other-pane', marker: 'tok1' });
    setTail('[AGENT_DONE:tok1]\n');
    outputEvent('[AGENT_DONE:tok1]\n');

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('ignores swarm markers while another project is loaded', () => {
    swarmState.loadedProjectPath = '/other';
    swarmState.activeAgents.push(agent('a1', { marker: 'tok1' }));
    setTail('[AGENT_DONE:tok1]\n');
    outputEvent('[AGENT_DONE:tok1]\n');

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
    expect(swarmState.ingestPlan).not.toHaveBeenCalled();
  });
});

describe('exit fallbacks', () => {
  it.each([
    [0, exitFallbackTransition(0)],
    [null, exitFallbackTransition(null)],
    [undefined, exitFallbackTransition(undefined)],
  ] as const)('parks a running agent in review on clean/unknown exit (%s)', (exitCode, expected) => {
    swarmState.activeAgents.push(agent('a1'));
    emit({ kind: 'exit', paneId: PANE, exitCode });

    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', expected.status, {
      statusReason: expected.statusReason,
    });
  });

  it('fails a running agent on a non-zero exit', () => {
    swarmState.activeAgents.push(agent('a1'));
    emit({ kind: 'exit', paneId: PANE, exitCode: 1 });

    const expected = exitFallbackTransition(1);
    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', expected.status, {
      statusReason: expected.statusReason,
    });
  });

  it('leaves finished agents untouched on exit', () => {
    swarmState.activeAgents.push(agent('a1', { status: 'review' }));
    emit({ kind: 'exit', paneId: PANE, exitCode: 0 });

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('records a pending exit instead of transitioning when the project is not loaded', () => {
    swarmState.loadedProjectPath = '/other';
    swarmState.activeAgents.push(agent('a1'));
    emit({ kind: 'exit', paneId: PANE, exitCode: 0 });

    expect(recordPendingAgentExit).toHaveBeenCalledWith('/proj', PANE, 0);
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('moves a progress task to review on a clean exit', () => {
    kanbanState.tasks.push({ id: 'task-1', title: 'Ship the thing', column: 'progress', terminalId: PANE });
    emit({ kind: 'exit', paneId: PANE, exitCode: 0 });

    expect(kanbanState.updateTask).toHaveBeenCalledWith('/proj', 'task-1', { column: 'review' });
    expect(notifyTaskReadyForReview).toHaveBeenCalledWith('Ship the thing');
  });

  it('leaves non-progress tasks and non-clean exits alone', () => {
    kanbanState.tasks.push(
      { id: 'task-1', column: 'backlog', terminalId: PANE },
      { id: 'task-2', column: 'progress', terminalId: 'other-pane' },
    );
    emit({ kind: 'exit', paneId: PANE, exitCode: 2 });

    expect(kanbanState.updateTask).not.toHaveBeenCalled();
    expect(notifyTaskReadyForReview).not.toHaveBeenCalled();
  });

  it('queues a pending task review on clean exit for an unloaded project', () => {
    kanbanState.loadedProjectPath = '/other';
    emit({ kind: 'exit', paneId: PANE, exitCode: 0 });

    expect(recordPendingTaskReview).toHaveBeenCalledWith('/proj', PANE);
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
  });

  it('does nothing when no project path resolves', () => {
    projectRef.currentProjectPath = null;
    emit({ kind: 'exit', paneId: PANE, exitCode: 0 });

    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
    expect(recordPendingAgentExit).not.toHaveBeenCalled();
    expect(kanbanState.updateTask).not.toHaveBeenCalled();
  });
});

describe('spawn failure fallback', () => {
  it('fails a running/starting agent whose pane never started', () => {
    swarmState.activeAgents.push(agent('a1', { status: 'starting' }));
    emit({ kind: 'spawn-failed', paneId: PANE, error: new Error('ConPTY gone') });

    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', 'failed', {
      statusReason: 'Terminal failed to start: Error: ConPTY gone',
    });
  });

  it('leaves finished agents and missing projects alone', () => {
    swarmState.activeAgents.push(agent('a1', { status: 'done' }));
    emit({ kind: 'spawn-failed', paneId: PANE, error: new Error('boom') });
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();

    swarmState.activeAgents.length = 0;
    projectRef.currentProjectPath = null;
    emit({ kind: 'spawn-failed', paneId: PANE, error: new Error('boom') });
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });
});

describe('bridge lifecycle', () => {
  it('stops translating after stop() runs', () => {
    const stop = startTerminalSwarmBridge();
    stop();

    setTail('[AGENT_DONE]\n');
    emit({ kind: 'output', paneId: PANE, data: '[AGENT_DONE]\n' });
    expect(swarmState.updateAgentStatus).not.toHaveBeenCalled();
  });

  it('re-subscribes cleanly after stop()', () => {
    startTerminalSwarmBridge()();
    startTerminalSwarmBridge();

    swarmState.activeAgents.push(agent('a1', { marker: 'tok1' }));
    setTail('[AGENT_DONE:tok1]\n');
    emit({ kind: 'output', paneId: PANE, data: '[AGENT_DONE:tok1]\n' });

    expect(swarmState.updateAgentStatus).toHaveBeenCalledWith('/proj', 'a1', 'done');
  });
});
