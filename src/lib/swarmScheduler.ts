// Pure swarm-scheduler helpers (Phase 3: review, swarm, and process correctness).
//
// These are the decision cores behind three swarmStore behaviors, kept side-effect free so
// they are directly testable:
//
// 1. `removeAgentFromRoster` - removing an agent must never strand its dependents: their
//    dependency edges to the removed agent are dropped, and any dependent that was only
//    blocked by it goes back to 'waiting' so the next scan re-evaluates it honestly.
// 2. `findHungAgents` - a configurable hung-agent ALERT based on `startedAt`. Alerting only:
//    Bridge never auto-kills a slow agent.
// 3. `findDeadlockedAgents` - scheduler deadlock detection: waiting agents whose dependencies
//    can never complete (missing from the roster, or terminally failed/blocked/stopped) while
//    nothing is running or starting. Left alone, such a swarm sits silently stuck forever.

import type { AgentStatus } from '../types/agent';

export interface SchedulerAgent {
  id: string;
  status: AgentStatus;
  dependencies: string[];
}

// Statuses that can never transition back to running. Mirrors the store's FINISHED set.
const TERMINAL_STATUSES: AgentStatus[] = ['done', 'failed', 'blocked', 'stopped'];

/**
 * Remove one agent from the roster and repair the graph around it: every remaining agent
 * loses its dependency edge to the removed id, and an agent whose blocked status came from
 * (or is made moot by) that edge returns to 'waiting' for the next scan.
 */
export function removeAgentFromRoster<T extends SchedulerAgent>(agents: T[], removedId: string): T[] {
  return agents
    .filter((a) => a.id !== removedId)
    .map((agent) => {
      const hadEdge = agent.dependencies.includes(removedId);
      if (!hadEdge) return agent;
      const dependencies = agent.dependencies.filter((d) => d !== removedId);
      const unblockedByRemoval =
        agent.status === 'blocked' &&
        dependencies.every((d) => {
          const dep = agents.find((a) => a.id === d);
          return !dep || dep.status === 'done';
        });
      return unblockedByRemoval
        ? { ...agent, dependencies, status: 'waiting' as AgentStatus }
        : { ...agent, dependencies };
    });
}

/**
 * Agents currently 'running' whose elapsed time since `startedAt` exceeds `thresholdMs`.
 * Pure alert candidates - the caller decides how to surface them and must not kill anything.
 */
export function findHungAgents<T extends { id: string; status: AgentStatus; startedAt?: number }>(
  agents: T[],
  now: number,
  thresholdMs: number,
): T[] {
  if (!(thresholdMs > 0)) return [];
  return agents.filter(
    (a) => a.status === 'running' && typeof a.startedAt === 'number' && now - a.startedAt > thresholdMs,
  );
}

/**
 * Waiting agents whose dependencies can never be satisfied by this roster: at least one
 * dependency is missing entirely or has reached a non-`done` terminal status. Such agents
 * stay 'waiting' through every scan while nothing runs - the silent-stuck state.
 */
export function findDeadlockedAgents<T extends SchedulerAgent>(agents: T[]): T[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const unsatisfiable = (depId: string): boolean => {
    const dep = byId.get(depId);
    return !dep || (dep.status !== 'done' && TERMINAL_STATUSES.includes(dep.status));
  };
  return agents.filter(
    (a) =>
      (a.status === 'waiting' || a.status === 'idle') &&
      a.dependencies.length > 0 &&
      a.dependencies.some(unsatisfiable),
  );
}
