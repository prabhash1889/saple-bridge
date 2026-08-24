import { describe, it, expect } from 'vitest';
import {
  removeAgentFromRoster,
  findHungAgents,
  findDeadlockedAgents,
  type SchedulerAgent,
} from './swarmScheduler';
import type { AgentStatus } from '../types/agent';

const a = (id: string, status: AgentStatus, dependencies: string[] = []): SchedulerAgent => ({
  id,
  status,
  dependencies,
});

describe('removeAgentFromRoster', () => {
  it('drops the agent and every dependency edge pointing at it', () => {
    const roster = removeAgentFromRoster(
      [a('root', 'done'), a('mid', 'waiting', ['root']), a('leaf', 'waiting', ['root', 'mid'])],
      'root',
    );

    expect(roster.map((x) => x.id)).toEqual(['mid', 'leaf']);
    expect(roster[1].dependencies).toEqual(['mid']);
  });

  it('returns an edge-blocked dependent to waiting so the next scan re-evaluates it', () => {
    // 'dep' was blocked because root failed; removing root removes that reason entirely.
    const roster = removeAgentFromRoster([a('dep', 'blocked', ['root'])], 'root');
    expect(roster[0].status).toBe('waiting');

    // A blocked agent with OTHER unresolved blockers stays blocked.
    const kept = removeAgentFromRoster(
      [a('other', 'failed'), a('dep', 'blocked', ['root', 'other'])],
      'root',
    );
    expect(kept.find((x) => x.id === 'dep')?.status).toBe('blocked');
    expect(kept.find((x) => x.id === 'dep')?.dependencies).toEqual(['other']);
  });

  it('removing an unknown id leaves the roster untouched', () => {
    const roster = [a('a', 'idle'), a('b', 'waiting', ['a'])];
    expect(removeAgentFromRoster(roster, 'ghost')).toEqual(roster);
  });
});

describe('findHungAgents', () => {
  const now = 1_000_000;

  it('flags only running agents past the threshold', () => {
    const agents = [
      { id: 'hung', status: 'running' as AgentStatus, startedAt: now - 30 * 60_000 },
      { id: 'fresh', status: 'running' as AgentStatus, startedAt: now - 60_000 },
      { id: 'done-long-ago', status: 'done' as AgentStatus, startedAt: now - 90 * 60_000 },
      { id: 'no-stamp', status: 'running' as AgentStatus },
    ];
    expect(findHungAgents(agents, now, 20 * 60_000).map((x) => x.id)).toEqual(['hung']);
  });

  it('a non-positive threshold disables alerting', () => {
    const agents = [{ id: 'x', status: 'running' as AgentStatus, startedAt: 0 }];
    expect(findHungAgents(agents, now, 0)).toEqual([]);
  });
});

describe('findDeadlockedAgents', () => {
  it('detects waiting agents depending on missing roster members', () => {
    const agents = [a('live', 'done'), a('stuck', 'waiting', ['ghost'])];
    expect(findDeadlockedAgents(agents).map((x) => x.id)).toEqual(['stuck']);
  });

  it('detects waiting agents depending on terminally failed or blocked deps', () => {
    const agents = [
      a('failed-dep', 'failed'),
      a('stuck', 'waiting', ['failed-dep']),
      a('fine', 'waiting', ['live']),
      a('live', 'running'),
    ];
    expect(findDeadlockedAgents(agents).map((x) => x.id)).toEqual(['stuck']);
  });

  it('never flags schedulable, active, or review-gated waits', () => {
    const agents = [
      a('ready', 'waiting', ['done-dep']),
      a('done-dep', 'done'),
      a('busy', 'running'),
      a('starting', 'starting'),
      a('gated', 'waiting', ['in-review']),
      a('in-review', 'review'),
    ];
    expect(findDeadlockedAgents(agents)).toEqual([]);
  });

  it('agents with no dependencies are never deadlocked', () => {
    expect(findDeadlockedAgents([a('idle-root', 'idle')])).toEqual([]);
  });
});
