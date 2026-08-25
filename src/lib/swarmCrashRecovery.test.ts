import { describe, it, expect } from 'vitest';
import type { AgentStatus } from '../types/agent';
import {
  reconcileLoadedAgents,
  recordPendingAgentExit,
  consumePendingAgentExits,
  type RecoveredTransition,
  type SwarmRunStatus,
} from './swarmCrashRecovery';

// A full SwarmAgent-shaped fixture: everything beyond the reconciliation-relevant fields must
// ride along untouched.
const agent = (
  id: string,
  status: AgentStatus,
  extra: Partial<{ terminalId: string; marker: string; taskId: string; statusReason: string }> = {},
) => ({
  id,
  name: id,
  role: 'builder',
  model: 'default',
  systemPrompt: 'test',
  dependencies: [] as string[],
  status,
  ...extra,
});

const tails: Record<string, string> = {};

const reconcile = (
  agents: ReturnType<typeof agent>[],
  opts: {
    loadedStatus?: SwarmRunStatus;
    liveSessions?: Record<string, unknown>;
    pendingExits?: Map<string, number | null | undefined>;
  } = {},
) =>
  reconcileLoadedAgents({
    agents,
    loadedStatus: opts.loadedStatus ?? 'running',
    liveSessions: opts.liveSessions ?? {},
    getSignalTail: (paneId) => tails[paneId] ?? '',
    pendingExits: opts.pendingExits ?? new Map(),
  });

describe('reconcileLoadedAgents', () => {
  it('fails a running agent whose pane no longer exists and pauses a running swarm', () => {
    const result = reconcile([agent('zombie', 'running', { terminalId: 'dead-pane' })]);

    expect(result.orphaned).toBe(true);
    expect(result.status).toBe('paused');
    const zombie = result.agents[0];
    expect(zombie.status).toBe('failed');
    expect(zombie.terminalId).toBeUndefined();
    expect(zombie.statusReason).toMatch(/restarted/i);
    expect(result.recovered).toEqual([]);
  });

  it('keeps the persisted run status when the swarm was not running', () => {
    const result = reconcile(
      [agent('zombie', 'running', { terminalId: 'dead-pane' })],
      { loadedStatus: 'completed' },
    );

    expect(result.orphaned).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('leaves agents whose pane still exists alone', () => {
    const result = reconcile([agent('alive', 'running', { terminalId: 'live-pane' })], {
      liveSessions: { 'live-pane': { id: 'live-pane' } },
    });

    expect(result.agents[0]).toMatchObject({ id: 'alive', status: 'running', terminalId: 'live-pane' });
    expect(result.orphaned).toBe(false);
    expect(result.status).toBe('running');
    expect(result.recovered).toEqual([]);
  });

  it('treats starting agents like running ones', () => {
    const result = reconcile([agent('spawning', 'starting', { terminalId: 'dead-pane' })]);

    expect(result.agents[0].status).toBe('failed');
    expect(result.orphaned).toBe(true);
  });

  it('ignores agents that are not running or starting', () => {
    const roster = [agent('done-1', 'done'), agent('idle-1', 'idle'), agent('blocked-1', 'blocked')];

    const result = reconcile(roster);

    expect(result.agents).toEqual(roster);
    expect(result.orphaned).toBe(false);
  });

  describe('marker-tail recovery (fast path)', () => {
    it('recovers a scoped completion marker instead of failing the agent', () => {
      tails['pane-a'] = 'final output\n[AGENT_DONE:tok1234]\n';
      try {
        const source = agent('a', 'running', { terminalId: 'pane-a', marker: 'tok1234' });
        const result = reconcile([source]);

        expect(result.recovered).toEqual([{ agentId: 'a', status: 'done' }] satisfies RecoveredTransition[]);
        expect(result.agents[0]).toBe(source); // untouched; the transition replays via updateAgentStatus
        expect(result.orphaned).toBe(false);
        expect(result.status).toBe('running');
      } finally {
        delete tails['pane-a'];
      }
    });

    it('a bare marker cannot advance a marker-scoped agent', () => {
      tails['pane-d'] = '[AGENT_DONE]\n';
      try {
        const result = reconcile([agent('d', 'running', { terminalId: 'pane-d', marker: 'tok7777' })], {
          liveSessions: { 'pane-d': { id: 'pane-d' } }, // still alive -> left alone
        });

        expect(result.recovered).toEqual([]);
        expect(result.agents[0].status).toBe('running');
      } finally {
        delete tails['pane-d'];
      }
    });

    it('a scoped failure marker recovers as failed', () => {
      tails['pane-f'] = '[AGENT_FAILED:tok5555]\n';
      try {
        const result = reconcile([agent('f', 'running', { terminalId: 'pane-f', marker: 'tok5555' })]);

        expect(result.recovered).toEqual([{ agentId: 'f', status: 'failed' }]);
      } finally {
        delete tails['pane-f'];
      }
    });

    it('the marker tail wins over a pending exit when both exist', () => {
      tails['pane-c'] = '[AGENT_FAILED:tok5555]\n';
      try {
        const result = reconcile([agent('c', 'running', { terminalId: 'pane-c', marker: 'tok5555' })], {
          pendingExits: new Map([['pane-c', 0]]),
        });

        expect(result.recovered).toEqual([{ agentId: 'c', status: 'failed' }]);
      } finally {
        delete tails['pane-c'];
      }
    });
  });

  describe('pending-exit recovery (safety net)', () => {
    it('applies the clean-exit fallback (review) for an exit code of 0', () => {
      const result = reconcile([agent('b', 'running', { terminalId: 'pane-b', marker: 'tok9999' })], {
        liveSessions: { 'pane-b': { id: 'pane-b' } },
        pendingExits: new Map([['pane-b', 0]]),
      });

      expect(result.recovered).toEqual([
        { agentId: 'b', status: 'review', statusReason: expect.stringContaining('without a completion signal') },
      ]);
      expect(result.orphaned).toBe(false);
    });

    it('applies the failed fallback for a non-zero exit code', () => {
      const result = reconcile([agent('x', 'running', { terminalId: 'pane-x' })], {
        pendingExits: new Map([['pane-x', 1]]),
      });

      expect(result.recovered).toEqual([
        { agentId: 'x', status: 'failed', statusReason: expect.stringContaining('exited with code 1') },
      ]);
      expect(result.orphaned).toBe(false);
    });
  });

  it('preserves unrelated agent fields through the zombie downgrade', () => {
    const result = reconcile([
      agent('w', 'running', { terminalId: 'gone', taskId: 'task-7', marker: 'mktok' }),
    ]);

    const zombie = result.agents[0] as ReturnType<typeof agent> & { taskId?: string };
    expect(zombie.taskId).toBe('task-7');
    expect(zombie.marker).toBe('mktok');
    expect(zombie.name).toBe('w');
  });
});

describe('pending agent-exit registry', () => {
  it('records exits per project and consumes them exactly once', () => {
    recordPendingAgentExit('/p1', 'pane-1', 0);
    recordPendingAgentExit('/p1', 'pane-2', null);
    recordPendingAgentExit('/p2', 'pane-3', 2);

    const p1 = consumePendingAgentExits('/p1');
    expect(p1.get('pane-1')).toBe(0);
    expect(p1.get('pane-2')).toBeNull();
    expect(p1.has('pane-3')).toBe(false);

    // Consumed is cleared: a second load must not replay stale exits.
    expect(consumePendingAgentExits('/p1').size).toBe(0);

    // Other projects are unaffected by /p1 consumption.
    const p2 = consumePendingAgentExits('/p2');
    expect(p2.get('pane-3')).toBe(2);
  });

  it('consuming a project with nothing recorded yields an empty map', () => {
    expect(consumePendingAgentExits('/never-recorded').size).toBe(0);
  });
});
