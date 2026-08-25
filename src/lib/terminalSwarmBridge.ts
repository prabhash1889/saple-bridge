// Bridge between the terminal transport layer and the domain stores (swarm + Kanban).
//
// terminalStore is a dumb PTY pipe: it records raw output, pane exits, and spawn failures and
// announces them as RawTerminalEvents (see subscribeRawTerminalEvents). This module owns the
// interpretation: lifecycle markers printed by an agent advance the linked swarm agent, review
// markers flip the Kanban task column, process exits park agents/tasks in a terminal state.
//
// Living here instead of inside terminalStore breaks the old terminal -> swarm import cycle:
// swarmStore reaches back into terminalStore (pane launching, signal-tail recovery), so the
// arrow between the terminal layer and swarm must point one way only. All imports below are
// static; no dynamic-import workarounds remain.

import {
  hasReviewSignal,
  mightContainSignal,
  mightContainAgentMarker,
  getSwarmStatusFromOutput,
  getPlanSignalFromOutput,
  exitFallbackTransition,
} from './agentSignals';
import { notifyTaskReadyForReview } from './desktopNotifications';
import { useKanbanStore, recordPendingTaskReview } from '../stores/kanbanStore';
import { useProjectStore } from '../stores/projectStore';
import { useSwarmStore } from '../stores/swarmStore';
import { recordPendingAgentExit } from './swarmCrashRecovery';
import {
  getPaneSignalTail,
  subscribeRawTerminalEvents,
  useTerminalStore,
  type RawTerminalEvent,
} from '../stores/terminalStore';

// Route lifecycle signals by the PANE's own project (P13), not whichever project the UI
// currently shows - a swarm/task agent keeps running (and finishing) after the user switches
// folders, and its signal must not be applied to (or dropped by) the wrong project's stores.
const resolvePaneProjectPath = (paneId: string) =>
  useTerminalStore.getState().sessions[paneId]?.workspacePath ||
  useProjectStore.getState().currentProjectPath;

// Output handler: detects lifecycle markers against the rolling per-pane tail (kept by
// terminalStore, already updated with this chunk before the event fired) and maps them to
// review/kanban/swarm transitions.
const handlePaneOutput = (paneId: string) => {
  // The cheap substring pre-filter skips the regex battery entirely for ordinary output (the
  // common case), so a marker split across two PTY bursts is still caught without scanning
  // everything.
  const signalTail = getPaneSignalTail(paneId);
  if (!mightContainSignal(signalTail)) return;

  const projectPath = resolvePaneProjectPath(paneId);

  // Review-request + kanban run on the bare (unscoped) markers: task panes and interactive
  // terminals have no per-agent marker to scope against.
  const reviewMatched = hasReviewSignal(signalTail);
  if (reviewMatched) {
    useTerminalStore.getState().requestReview(paneId);
    if (projectPath) {
      const kanban = useKanbanStore.getState();
      if (kanban.loadedProjectPath === projectPath) {
        const task = kanban.tasks.find((t) => t.terminalId === paneId);
        if (task && task.column !== 'review') {
          void kanban.updateTask(projectPath, task.id, { column: 'review' });
          notifyTaskReadyForReview(task.title);
        }
      } else {
        // Pane belongs to a project whose kanban isn't loaded - queue the review move;
        // loadTasks applies it (if a task actually links this pane) when the project opens.
        recordPendingTaskReview(projectPath, paneId);
      }
    }
  }

  // Swarm completion is matched against the LINKED agent's own marker, so an agent can't be
  // advanced by another pane's output or by echoing the generic marker name. Only reach for
  // swarm state when the tail actually holds a marker keyword (skips `arr[0]`-style typing).
  if (projectPath && mightContainAgentMarker(signalTail)) {
    // P13: only the loaded project's swarm can transition here. Another project's agent
    // recovers from this pane's signal tail when its swarm loads (see loadSwarmState).
    if (useSwarmStore.getState().loadedProjectPath !== projectPath) return;
    const linkedAgent = useSwarmStore.getState().activeAgents.find((agent) => agent.terminalId === paneId);
    if (!linkedAgent) return;
    // Swarm v2: a coordinator's plan marker drives plan intake (materialize workers). The
    // watcher event is the fallback; the marker is the primary, ms-latency trigger.
    if (getPlanSignalFromOutput(signalTail, linkedAgent.marker)) {
      void useSwarmStore.getState().ingestPlan(projectPath);
    }
    const scopedReview = hasReviewSignal(signalTail, linkedAgent.marker);
    const nextSwarmStatus = getSwarmStatusFromOutput(signalTail, scopedReview, linkedAgent.marker);
    if (!nextSwarmStatus || linkedAgent.status === nextSwarmStatus) return;
    // Mirror the pane's review badge for a scoped review marker (the bare-marker path above
    // misses `[REVIEW_REQUESTED:<token>]`).
    if (nextSwarmStatus === 'review') useTerminalStore.getState().requestReview(paneId);
    void useSwarmStore.getState().updateAgentStatus(projectPath, linkedAgent.id, nextSwarmStatus);
  }
};

// Exit fallback: lifecycle markers are the fast path, process exit is the safety net. A swarm
// agent still running/starting when its PTY exits gets a terminal state instead of hanging the
// swarm forever - clean/unknown exit parks it in review (human confirms; auto-approve agents
// advance straight to done), a non-zero exit fails it.
const handlePaneExit = (paneId: string, exitCode: number | null | undefined) => {
  const projectPath = resolvePaneProjectPath(paneId);
  if (!projectPath) return;

  const swarm = useSwarmStore.getState();
  if (swarm.loadedProjectPath !== projectPath) {
    // P13: this pane's project isn't loaded, so its swarm can't transition now. Record the
    // exit; loadSwarmState replays it (marker tail first, exit fallback second).
    recordPendingAgentExit(projectPath, paneId, exitCode);
  } else {
    const agent = swarm.activeAgents.find((a) => a.terminalId === paneId);
    if (agent && (agent.status === 'running' || agent.status === 'starting')) {
      const { status, statusReason } = exitFallbackTransition(exitCode);
      void swarm.updateAgentStatus(projectPath, agent.id, status, { statusReason });
    }
  }

  // Same safety net for Kanban task panes: an agent that exits cleanly without printing a
  // review marker still moves its task to the review column instead of sitting "in progress"
  // against a dead terminal. Non-zero/unknown exits leave the column untouched.
  if (exitCode === 0) {
    const kanban = useKanbanStore.getState();
    if (kanban.loadedProjectPath === projectPath) {
      const task = kanban.tasks.find((t) => t.terminalId === paneId);
      if (task && task.column === 'progress') {
        void kanban.updateTask(projectPath, task.id, { column: 'review' });
        notifyTaskReadyForReview(task.title);
      }
    } else {
      recordPendingTaskReview(projectPath, paneId); // applied by loadTasks when the project opens (P13)
    }
  }
};

// A swarm agent whose pane never started is failed immediately so its dependents stop waiting
// on a dead terminal. Preserved quirk from the pre-inversion handler: unlike the exit fallback,
// this routes by the ACTIVE project rather than the pane's own workspacePath.
const handleSpawnFailed = (paneId: string, err: unknown) => {
  const projectPath = useProjectStore.getState().currentProjectPath;
  if (!projectPath) return;

  const agent = useSwarmStore.getState().activeAgents.find((a) => a.terminalId === paneId);
  if (!agent || (agent.status !== 'running' && agent.status !== 'starting')) return;
  void useSwarmStore.getState().updateAgentStatus(projectPath, agent.id, 'failed', {
    statusReason: `Terminal failed to start: ${String(err)}`,
  });
};

const handleRawTerminalEvent = (event: RawTerminalEvent) => {
  switch (event.kind) {
    case 'output':
      handlePaneOutput(event.paneId);
      break;
    case 'exit':
      handlePaneExit(event.paneId, event.exitCode);
      break;
    case 'spawn-failed':
      handleSpawnFailed(event.paneId, event.error);
      break;
  }
};

let unsubscribe: (() => void) | null = null;

/**
 * Start translating raw terminal transport events into swarm/Kanban transitions. Idempotent:
 * repeated calls reuse the single subscription and return the same stop function. Returns a
 * stop function suitable as a React effect cleanup.
 */
export function startTerminalSwarmBridge(): () => void {
  if (!unsubscribe) {
    unsubscribe = subscribeRawTerminalEvents(handleRawTerminalEvent);
  }
  return () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
