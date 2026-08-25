// Crash/restart reconciliation for a loaded swarm roster (P13 + Phase 3).
//
// `.saple/swarm/state.json` can say an agent is running while its PTY no longer exists (the app
// restarted mid-run). Left alone, those zombies stay "running" forever and their dependents never
// start. On every project load this module decides, per agent:
//
// 1. Marker tail first (fast path): the pane's rolling signal tail may already hold the scoped
//    completion marker of an agent that FINISHED while another project was open. Its live
//    transition was dropped by the handlers on purpose; recover it here instead of failing it.
// 2. Pending exits second (safety net): a pty-exit that fired while the project wasn't loaded is
//    replayed through its fallback transition (clean/unknown exit -> review, non-zero -> failed).
//    The marker tail wins when both exist.
// 3. A pane that still exists in this session stays untouched.
// 4. Anything else is a zombie: downgrade to failed (Relaunch stays one click away).
//
// If any agent was orphaned, a run that claimed to be `running` comes back `paused`, so continuing
// is a deliberate Resume.
//
// Pure decision core: sessions, signal tails, and pending exits arrive as parameters, so the rules
// are unit-testable without stores or PTYs. Callers replay the returned `recovered` transitions
// through the store's normal updateAgentStatus path so completion side effects (persistence,
// notifications, run close-out, scheduler advance) fire exactly as if the user had been watching.

import type { AgentStatus } from '../types/agent';
import { hasReviewSignal, getSwarmStatusFromOutput, exitFallbackTransition } from './agentSignals';

export type SwarmRunStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

// P13: pty-exits for panes whose project isn't the loaded one, recorded by terminalSwarmBridge and
// replayed by loadSwarmState (after the marker-tail check, which wins when both exist). In-memory
// on purpose: the switch-and-return scenario lives within one app session; across a restart the
// PTYs are dead anyway and the zombie reconciliation applies.
const pendingAgentExits = new Map<string, Map<string, number | null | undefined>>();

export const recordPendingAgentExit = (
  projectPath: string,
  terminalId: string,
  exitCode: number | null | undefined,
): void => {
  const forProject = pendingAgentExits.get(projectPath) ?? new Map();
  forProject.set(terminalId, exitCode);
  pendingAgentExits.set(projectPath, forProject);
};

/** Take (and clear) every pending exit recorded for a project. */
export const consumePendingAgentExits = (
  projectPath: string,
): Map<string, number | null | undefined> => {
  const forProject = pendingAgentExits.get(projectPath) ?? new Map<string, number | null | undefined>();
  pendingAgentExits.delete(projectPath);
  return forProject;
};

// The fields reconciliation reads; all other agent fields ride along untouched.
interface ReconcilableAgent {
  id: string;
  status: AgentStatus;
  terminalId?: string;
  marker?: string;
}

export interface RecoveredTransition {
  agentId: string;
  status: AgentStatus;
  statusReason?: string;
}

export interface ReconcileLoadedAgentsInput<T> {
  agents: T[];
  // Run status as persisted in state.json, before reconciliation.
  loadedStatus: SwarmRunStatus;
  // Terminal panes that still exist in this app session, keyed by pane id.
  liveSessions: Record<string, unknown>;
  // Rolling per-pane marker tail ('' when unknown), as kept by terminalStore.
  getSignalTail: (terminalId: string) => string;
  // Exits recorded while this project was not loaded; consumed by the caller.
  pendingExits: ReadonlyMap<string, number | null | undefined>;
}

export interface ReconciledSwarmLoad<T> {
  agents: T[];
  status: SwarmRunStatus;
  // True when at least one running/starting agent lost its pane and was failed.
  orphaned: boolean;
  // Transitions to replay through updateAgentStatus (they persist, notify, close out, advance).
  recovered: RecoveredTransition[];
}

export function reconcileLoadedAgents<T extends ReconcilableAgent>(
  input: ReconcileLoadedAgentsInput<T>,
): ReconciledSwarmLoad<T> {
  let orphaned = false;
  const recovered: RecoveredTransition[] = [];
  const agents = input.agents.map((agent): T => {
    if (agent.status !== 'running' && agent.status !== 'starting') return agent;
    if (agent.terminalId) {
      const tail = input.getSignalTail(agent.terminalId);
      if (tail) {
        const scopedReview = hasReviewSignal(tail, agent.marker);
        const recoveredStatus = getSwarmStatusFromOutput(tail, scopedReview, agent.marker);
        if (recoveredStatus) {
          recovered.push({ agentId: agent.id, status: recoveredStatus });
          return agent;
        }
      }
      if (input.pendingExits.has(agent.terminalId)) {
        const transition = exitFallbackTransition(input.pendingExits.get(agent.terminalId));
        recovered.push({ agentId: agent.id, ...transition });
        return agent;
      }
      if (input.liveSessions[agent.terminalId]) return agent;
    }
    orphaned = true;
    return {
      ...agent,
      status: 'failed' as AgentStatus,
      terminalId: undefined,
      statusReason: 'Agent terminal was lost (app restarted mid-run) — relaunch to continue.',
    };
  });
  const status =
    orphaned && input.loadedStatus === 'running' ? ('paused' as SwarmRunStatus) : input.loadedStatus;
  return { agents, status, orphaned, recovered };
}
