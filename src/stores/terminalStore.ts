import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useKanbanStore } from './kanbanStore';
import { useProjectStore } from './projectStore';
import { useAgentSessionStore } from './agentSessionStore';
import { useTerminalLayoutStore } from './terminalLayoutStore';
import { createId } from '../lib/id';
import { TERMINAL_OUTPUT_BUFFER_CHARS } from '../lib/terminalLimits';
import type { AgentProvider } from '../types/provider';

export type AiProvider = Extract<AgentProvider, 'codex' | 'claude' | 'gemini' | 'openrouter' | 'opencode' | 'cursor' | 'droid' | 'copilot' | 'pi' | 'custom'>;

export interface CommandBlock {
  id: string;
  command: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  outputPreview: string;
}

export interface TerminalSession {
  id: string;
  name: string;
  dynamicTitle?: string;
  groupColor: string;
  cwd: string;
  workspacePath: string;
  // Identifies which workspace instance owns this pane. Distinct from `workspacePath`
  // so the same folder opened twice keeps two independent sets of panes. Falls back to
  // the path for sessions created before instance ids existed.
  workspaceId: string;
  aiProvider?: AiProvider;
  // Model the AI CLI was launched with, kept so a restored pane can relaunch the same model.
  model?: string;
  customCommand?: string;
  agentSessionId?: string;
  commandBlocks: CommandBlock[];
  lastCommandInput: string;
}

// One restorable pane: just enough to re-spawn a fresh shell that matches the old one.
// Pane ids are NOT saved (a new id is minted on restore); order is the array order.
export interface SavedPane {
  name: string;
  cwd: string;
  groupColor: string;
  aiProvider?: AiProvider;
  model?: string;
  customCommand?: string;
}

// The saved terminal layout for one workspace, keyed by workspace *path* (the stable
// identity that survives app restart and reopening from History, unlike the instance id).
export interface SavedWorkspaceLayout {
  panes: SavedPane[];
  focusedIndex: number | null;
  maximizedIndex: number | null;
  savedAt: string;
}

interface TerminalOutputEvent {
  paneId: string;
  data: string;
  sequence: number;
}

type TerminalOutputListener = (event: TerminalOutputEvent) => void;

interface TerminalState {
  panes: string[];
  sessions: Record<string, TerminalSession>;
  focusedPaneId: string | null;
  maximizedPaneId: string | null;
  reviewPanes: Record<string, boolean>;
  workspacePanes: Record<string, string[]>;
  workspaceFocusedPaneIds: Record<string, string | null>;
  workspaceMaximizedPaneIds: Record<string, string | null>;
  ptyOutputListenerStarted: boolean;

  initialize: () => Promise<void>;
  activateWorkspace: (workspaceKey: string | null) => void;
  startPtyOutputListener: () => Promise<void>;
  stopPtyOutputListener: () => Promise<void>;
  appendOutput: (paneId: string, data: string) => void;
  subscribeOutput: (paneId: string, listener: TerminalOutputListener) => () => void;
  getBufferedOutput: (paneId: string) => string;
  getLatestSequence: (paneId: string) => number;
  addPane: (cwd: string, aiProvider?: AiProvider, model?: string, promptFile?: string, customCommand?: string) => Promise<string>;
  splitPane: (paneId: string, cwd: string) => Promise<string>;
  removePane: (paneId: string) => Promise<void>;
  closeWorkspaceTerminals: (workspaceKey: string) => Promise<void>;
  restoreWorkspacePanes: (workspacePath: string) => Promise<void>;
  setFocusedPane: (paneId: string | null) => void;
  setMaximizedPane: (paneId: string | null) => void;
  toggleMaximizePane: (paneId: string) => void;
  getMaxPaneLimit: () => number;
  canAddPane: () => boolean;
  updateSession: (paneId: string, updates: Partial<TerminalSession>) => void;
  setAiProvider: (paneId: string, provider: AiProvider) => void;
  recordCommand: (paneId: string, command: string) => void;
  requestReview: (paneId: string) => void;
  resolveReview: (paneId: string) => void;
  clearAll: () => Promise<void>;
  persistOutputToLog: (paneId: string, content: string, projectPath: string) => Promise<void>;
}

const COLOR_PRESETS = ['#5D5FEF', '#10B981', '#EF4444', '#F59E0B', '#3B82F6', '#EC4899'];
const DEFAULT_MAX_PANES = 16;
const MAX_COMMAND_BLOCKS = 20;

const outputListeners = new Map<string, Set<TerminalOutputListener>>();
const pendingOutputChunks = new Map<string, string[]>();

// Live terminal output is kept in plain module-level maps rather than reactive Zustand
// state. xterm panes render via the `subscribeOutput` listener path (see TerminalPane),
// and the only readers of the buffer/sequence are TerminalPane's mount-time replay
// (via getBufferedOutput / getLatestSequence). Keeping this out of the store means the
// per-frame output flush no longer calls set(), so it doesn't run every store
// subscriber's selector ~60x/sec under heavy output.
const paneOutputBuffers = new Map<string, string[]>();
const paneOutputLengths = new Map<string, number>();
const paneLatestSequence = new Map<string, number>();

// Short rolling tail of each pane's raw output, used only for agent-signal detection.
// Bounded so a marker split across PTY bursts is rejoined, without retaining real output.
const paneSignalTails = new Map<string, string>();
const SIGNAL_TAIL_CHARS = 512;

// Append the latest chunk to a pane's signal tail and return the (bounded) result.
const appendSignalTail = (paneId: string, data: string) => {
  const next = ((paneSignalTails.get(paneId) ?? '') + data).slice(-SIGNAL_TAIL_CHARS);
  paneSignalTails.set(paneId, next);
  return next;
};

let outputFlushFrame: number | null = null;
let outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
let swarmStorePromise: Promise<typeof import('./swarmStore')> | null = null;
let ptyOutputUnlisten: UnlistenFn | null = null;
let ptyExitUnlisten: UnlistenFn | null = null;

const getActiveWorkspacePath = () => useProjectStore.getState().currentProjectPath;

// Panes are bucketed by workspace *instance* id (not path) so duplicate openings of the
// same folder stay independent. Older sessions without an id fall back to their path.
const getActiveWorkspaceKey = () =>
  useProjectStore.getState().currentWorkspaceId || useProjectStore.getState().currentProjectPath;

const getWorkspaceKeyForPane = (session?: TerminalSession | null) =>
  session?.workspaceId || session?.workspacePath || session?.cwd || getActiveWorkspaceKey() || '';

const resolveFocusedPane = (panes: string[], focusedPaneId?: string | null) =>
  focusedPaneId && panes.includes(focusedPaneId) ? focusedPaneId : panes[panes.length - 1] ?? null;

const scheduleFrame = (callback: () => void) => {
  // While the window is minimized/occluded the browser PAUSES requestAnimationFrame. PTY events
  // keep arriving though, so pendingOutputChunks would grow unbounded and then replay in one
  // giant, UI-freezing write the moment the window is restored. Fall back to a timer (which keeps
  // firing, just throttled) whenever the document is hidden so output keeps draining steadily.
  if (typeof document !== 'undefined' && document.hidden) {
    outputFlushTimer = setTimeout(callback, 100);
    return;
  }
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    outputFlushFrame = window.requestAnimationFrame(callback);
    return;
  }

  outputFlushTimer = setTimeout(callback, 16);
};

const cancelScheduledOutputFlush = () => {
  if (outputFlushFrame !== null && typeof window !== 'undefined') {
    window.cancelAnimationFrame(outputFlushFrame);
  }
  if (outputFlushTimer !== null) {
    clearTimeout(outputFlushTimer);
  }
  outputFlushFrame = null;
  outputFlushTimer = null;
};

const notifyOutputListeners = (events: TerminalOutputEvent[]) => {
  for (const event of events) {
    const listeners = outputListeners.get(event.paneId);
    if (!listeners) continue;
    for (const listener of Array.from(listeners)) {
      listener(event);
    }
  }
};

// Agent lifecycle markers are matched against a rolling per-pane tail (see
// `appendSignalTail`) so a marker split across two PTY bursts — e.g. `[AGENT_` in one
// chunk and `DONE]` in the next — is still detected. The regexes are line-anchored
// (`/m`) so a marker only fires when an agent emits it on its own line, not when it's
// echoed mid-sentence or printed back inside a command the user typed.
const SIGNAL_DONE_RE = /^\s*\[(?:AGENT_DONE|TASK_COMPLETE|TASK_DONE)\]\s*$/m;
const SIGNAL_FAILED_RE = /^\s*\[(?:AGENT_FAILED|TASK_FAILED)\]\s*$/m;
const SIGNAL_REVIEW_RE =
  /^\s*(?:\[(?:AGENT_REVIEW|REVIEW_REQUESTED)\]|##\s*REVIEW REQUIRED|Task complete\. Review required\.)\s*$/m;

const hasReviewSignal = (tail: string) => SIGNAL_REVIEW_RE.test(tail);

// Cheap substring pre-filter run before the regex battery: every lifecycle marker contains one
// of these literals (`[` for the bracketed markers, `#` for `## REVIEW REQUIRED`, or the
// `Task complete` phrase). Ordinary terminal output has none, so this short-circuits the regex
// tests for the overwhelmingly common no-marker case on the per-event hot path.
const mightContainSignal = (tail: string) =>
  tail.includes('[') || tail.includes('#') || tail.includes('Task complete');

// `reviewMatched` is the already-computed `hasReviewSignal` result, threaded in so the review
// regex isn't run a second time here (it used to re-test SIGNAL_REVIEW_RE redundantly).
const getSwarmStatusFromOutput = (tail: string, reviewMatched: boolean) => {
  if (SIGNAL_DONE_RE.test(tail)) return 'done' as const;
  if (SIGNAL_FAILED_RE.test(tail)) return 'failed' as const;
  if (reviewMatched) return 'review' as const;
  return null;
};

const providerLabel = (provider?: AiProvider) => {
  switch (provider) {
    case 'claude':
      return 'Claude Agent';
    case 'opencode':
      return 'OpenCode Agent';
    case 'codex':
      return 'Codex Agent';
    case 'gemini':
      return 'Gemini Agent';
    case 'openrouter':
      return 'OpenRouter Agent';
    case 'cursor':
      return 'Cursor Agent';
    case 'droid':
      return 'Droid Agent';
    case 'copilot':
      return 'Copilot Agent';
    case 'pi':
      return 'Pi Agent';
    case 'custom':
      return 'Custom Agent';
    default:
      return 'Terminal';
  }
};

export const useTerminalStore = create<TerminalState>()((set, get) => {
  const flushPendingOutput = () => {
    outputFlushFrame = null;
    outputFlushTimer = null;

    const pending = Array.from(pendingOutputChunks.entries());
    pendingOutputChunks.clear();
    if (pending.length === 0) return;

    const events: TerminalOutputEvent[] = [];

    for (const [paneId, queuedChunks] of pending) {
      const batchedData = queuedChunks.join('');
      if (!batchedData) continue;

      const nextChunks = paneOutputBuffers.get(paneId) ?? [];
      nextChunks.push(batchedData);
      let nextLength = (paneOutputLengths.get(paneId) ?? 0) + batchedData.length;

      while (nextLength > TERMINAL_OUTPUT_BUFFER_CHARS && nextChunks.length > 1) {
        const removed = nextChunks.shift();
        nextLength -= removed?.length ?? 0;
      }

      if (nextLength > TERMINAL_OUTPUT_BUFFER_CHARS && nextChunks.length === 1) {
        nextChunks[0] = nextChunks[0].slice(-TERMINAL_OUTPUT_BUFFER_CHARS);
        nextLength = nextChunks[0].length;
      }

      const nextSequence = (paneLatestSequence.get(paneId) ?? 0) + 1;
      paneOutputBuffers.set(paneId, nextChunks);
      paneOutputLengths.set(paneId, nextLength);
      paneLatestSequence.set(paneId, nextSequence);

      events.push({ paneId, data: batchedData, sequence: nextSequence });
    }

    notifyOutputListeners(events);
    // NOTE: command detection deliberately does NOT run here. It used to parse the OUTPUT stream
    // every frame and call set() (re-rendering the pane ~60x/sec during plain-text streaming) —
    // and it logged shell output as "commands" rather than what the user typed. It now runs off
    // the INPUT path in TerminalPane.onData (see `recordCommand`), firing only when the user
    // presses Enter, so the hot output path no longer touches reactive state.
  };

  // Snapshot a workspace instance's current panes into the persisted layout store (keyed by
  // path) so they can be re-spawned later. An empty pane list clears the saved entry, so a
  // workspace the user fully closed stops offering a stale "Restore previous terminals" button.
  const captureLayout = (workspaceKey: string, fallbackPath?: string) => {
    if (!workspaceKey) return;
    const state = get();
    const paneIds = state.workspacePanes[workspaceKey] || [];
    const firstSession = paneIds.length ? state.sessions[paneIds[0]] : undefined;
    const path = firstSession?.workspacePath || fallbackPath || getActiveWorkspacePath();
    if (!path) return;

    if (paneIds.length === 0) {
      useTerminalLayoutStore.getState().clearLayout(path);
      return;
    }

    const panes: SavedPane[] = paneIds
      .map((paneId) => state.sessions[paneId])
      .filter((session): session is TerminalSession => Boolean(session))
      .map((session) => ({
        name: session.name,
        cwd: session.cwd,
        groupColor: session.groupColor,
        aiProvider: session.aiProvider,
        model: session.model,
        customCommand: session.customCommand,
      }));

    const focusedId = state.workspaceFocusedPaneIds[workspaceKey] ?? null;
    const maximizedId = state.workspaceMaximizedPaneIds[workspaceKey] ?? null;
    const focusedIndex = focusedId ? paneIds.indexOf(focusedId) : -1;
    const maximizedIndex = maximizedId ? paneIds.indexOf(maximizedId) : -1;

    useTerminalLayoutStore.getState().setLayout(path, {
      panes,
      focusedIndex: focusedIndex >= 0 ? focusedIndex : null,
      maximizedIndex: maximizedIndex >= 0 ? maximizedIndex : null,
      savedAt: new Date().toISOString(),
    });
  };

  return {
    panes: [],
    sessions: {},
    focusedPaneId: null,
    maximizedPaneId: null,
    reviewPanes: {},
    workspacePanes: {},
    workspaceFocusedPaneIds: {},
    workspaceMaximizedPaneIds: {},
    ptyOutputListenerStarted: false,

    initialize: async () => {
      await get().startPtyOutputListener();
    },

    activateWorkspace: (workspaceKey) => {
      if (!workspaceKey) {
        set({ panes: [], focusedPaneId: null, maximizedPaneId: null });
        return;
      }

      set((state) => {
        const panes = state.workspacePanes[workspaceKey] || [];
        const focusedPaneId = resolveFocusedPane(panes, state.workspaceFocusedPaneIds[workspaceKey]);
        const maximizedPaneId = panes.includes(state.workspaceMaximizedPaneIds[workspaceKey] || '')
          ? state.workspaceMaximizedPaneIds[workspaceKey]
          : null;

        return {
          panes,
          focusedPaneId,
          maximizedPaneId,
          workspaceFocusedPaneIds: { ...state.workspaceFocusedPaneIds, [workspaceKey]: focusedPaneId },
          workspaceMaximizedPaneIds: { ...state.workspaceMaximizedPaneIds, [workspaceKey]: maximizedPaneId },
        };
      });
    },

    startPtyOutputListener: async () => {
      if (get().ptyOutputListenerStarted) return;
      set({ ptyOutputListenerStarted: true });

      ptyOutputUnlisten = await listen<{ id: string; data: string }>('pty-output', (event) => {
        const { id, data } = event.payload;
        get().appendOutput(id, data);

        // Detect lifecycle markers against the rolling tail (not the raw chunk) so a
        // marker split across two PTY bursts is still caught. The cheap substring pre-filter
        // skips the regex battery entirely for ordinary output (the common case).
        const signalTail = appendSignalTail(id, data);
        if (!mightContainSignal(signalTail)) return;

        const reviewMatched = hasReviewSignal(signalTail);
        const nextSwarmStatus = getSwarmStatusFromOutput(signalTail, reviewMatched);
        if (!reviewMatched && !nextSwarmStatus) return;

        const projectPath = useProjectStore.getState().currentProjectPath;

        if (reviewMatched) {
          get().requestReview(id);
          const task = useKanbanStore.getState().tasks.find((t) => t.terminalId === id);
          if (projectPath && task && task.column !== 'review') {
            void useKanbanStore.getState().updateTask(projectPath, task.id, { column: 'review' });
          }
        }

        if (projectPath && nextSwarmStatus) {
          swarmStorePromise ??= import('./swarmStore');
          swarmStorePromise
            .then(({ useSwarmStore }) => {
              const linkedAgent = useSwarmStore.getState().activeAgents.find((agent) => agent.terminalId === id);
              if (linkedAgent && linkedAgent.status !== nextSwarmStatus) {
                void useSwarmStore.getState().updateAgentStatus(projectPath, linkedAgent.id, nextSwarmStatus);
              }
            })
            .catch((err) => console.error('Failed to import swarmStore dynamically:', err));
        }
      });

      // A PTY whose child exited (or whose reader gave up after persistent errors) emits
      // `pty-exit`. Surface it as a visible, dimmed notice inside the pane so an ended session is
      // obvious instead of looking like a frozen terminal. Ignore it for panes the user already
      // closed (session gone). This goes through the normal output path, not the signal tail, so
      // the injected notice is never mistaken for an agent marker.
      ptyExitUnlisten = await listen<{ id: string }>('pty-exit', (event) => {
        const { id } = event.payload;
        if (!get().sessions[id]) return;
        get().appendOutput(id, '\r\n\x1b[2m[process exited — close this pane to start a new one]\x1b[0m\r\n');
      });
    },

    stopPtyOutputListener: async () => {
      if (ptyOutputUnlisten) {
        await ptyOutputUnlisten();
        ptyOutputUnlisten = null;
      }
      if (ptyExitUnlisten) {
        await ptyExitUnlisten();
        ptyExitUnlisten = null;
      }
      set({ ptyOutputListenerStarted: false });
    },

    appendOutput: (paneId, data) => {
      const chunks = pendingOutputChunks.get(paneId);
      if (chunks) {
        chunks.push(data);
      } else {
        pendingOutputChunks.set(paneId, [data]);
      }

      if (outputFlushFrame === null && outputFlushTimer === null) {
        scheduleFrame(flushPendingOutput);
      }
    },

    subscribeOutput: (paneId, listener) => {
      const listeners = outputListeners.get(paneId) ?? new Set<TerminalOutputListener>();
      listeners.add(listener);
      outputListeners.set(paneId, listeners);

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          outputListeners.delete(paneId);
        }
      };
    },

    getBufferedOutput: (paneId) => (paneOutputBuffers.get(paneId) ?? []).join(''),

    getLatestSequence: (paneId) => paneLatestSequence.get(paneId) ?? 0,

    persistOutputToLog: async (paneId, content, projectPath) => {
      const session = get().sessions[paneId];
      const agentSession = session?.agentSessionId
        ? useAgentSessionStore.getState().getSessionByTerminalId(paneId)
        : undefined;
      if (!agentSession?.outputLogPath) return;

      try {
        const existing = await invoke<string>('read_project_file', {
          projectPath,
          filePath: agentSession.outputLogPath,
        }).catch(() => '');
        await invoke('write_project_file', {
          projectPath,
          filePath: agentSession.outputLogPath,
          content: existing + content,
        });
      } catch (err) {
        console.error('Failed to persist output log:', err);
      }
    },

    addPane: async (cwd, aiProvider, model, promptFile, customCommand) => {
      const id = createId('term');
      const workspacePath = cwd || getActiveWorkspacePath() || '';
      // Panes are always added to the active workspace instance; spawn still uses `cwd`.
      const workspaceKey = getActiveWorkspaceKey() || workspacePath;
      const index = get().workspacePanes[workspaceKey]?.length || 0;
      const color = COLOR_PRESETS[index % COLOR_PRESETS.length];

      const newSession: TerminalSession = {
        id,
        name: customCommand ? `Custom Command ${index + 1}` : `${providerLabel(aiProvider)} ${index + 1}`,
        groupColor: color,
        cwd,
        workspacePath,
        workspaceId: workspaceKey,
        aiProvider,
        model,
        customCommand,
        commandBlocks: [],
        lastCommandInput: '',
      };

      set((state) => ({
        panes: getActiveWorkspaceKey() === workspaceKey ? [...(state.workspacePanes[workspaceKey] || []), id] : state.panes,
        workspacePanes: {
          ...state.workspacePanes,
          [workspaceKey]: [...(state.workspacePanes[workspaceKey] || []), id],
        },
        workspaceFocusedPaneIds: { ...state.workspaceFocusedPaneIds, [workspaceKey]: id },
        sessions: { ...state.sessions, [id]: newSession },
        focusedPaneId: getActiveWorkspaceKey() === workspaceKey ? id : state.focusedPaneId,
      }));

      invoke('spawn_pty', { id, cwd, env: {}, aiProvider, model, promptFile, customCommand }).catch((err) => {
        console.error(`Failed to spawn PTY session ${id}:`, err);
      });

      captureLayout(workspaceKey, workspacePath);
      return id;
    },

    // Duplicate the focused pane: spawn a fresh shell that inherits the parent's
    // provider/model/command/color and insert it directly after the parent in the grid.
    splitPane: async (paneId, cwd) => {
      const parentSession = get().sessions[paneId];
      const workspaceKey = getWorkspaceKeyForPane(parentSession) || getActiveWorkspaceKey() || '';
      const workspacePanes = get().workspacePanes[workspaceKey] || [];
      if (workspacePanes.length >= get().getMaxPaneLimit()) {
        return paneId;
      }

      const id = createId('term');
      const index = workspacePanes.length;
      const spawnCwd = cwd || parentSession?.cwd || getActiveWorkspacePath() || '';
      const workspacePath = parentSession?.workspacePath || spawnCwd;
      const newSession: TerminalSession = {
        id,
        name: parentSession?.customCommand
          ? `Custom Command ${index + 1}`
          : `${providerLabel(parentSession?.aiProvider)} ${index + 1}`,
        groupColor: parentSession?.groupColor || COLOR_PRESETS[index % COLOR_PRESETS.length],
        cwd: spawnCwd,
        workspacePath,
        workspaceId: workspaceKey,
        aiProvider: parentSession?.aiProvider,
        model: parentSession?.model,
        customCommand: parentSession?.customCommand,
        commandBlocks: [],
        lastCommandInput: '',
      };

      set((state) => {
        const panesForWorkspace = state.workspacePanes[workspaceKey] || [];
        const parentIdx = panesForWorkspace.indexOf(paneId);
        const newPanes = [...panesForWorkspace];
        if (parentIdx !== -1) {
          newPanes.splice(parentIdx + 1, 0, id);
        } else {
          newPanes.push(id);
        }
        const isActiveWorkspace = getActiveWorkspaceKey() === workspaceKey;

        return {
          panes: isActiveWorkspace ? newPanes : state.panes,
          workspacePanes: { ...state.workspacePanes, [workspaceKey]: newPanes },
          workspaceFocusedPaneIds: { ...state.workspaceFocusedPaneIds, [workspaceKey]: id },
          sessions: { ...state.sessions, [id]: newSession },
          focusedPaneId: isActiveWorkspace ? id : state.focusedPaneId,
        };
      });

      invoke('spawn_pty', {
        id,
        cwd: newSession.cwd,
        env: {},
        aiProvider: newSession.aiProvider,
        model: newSession.model,
        customCommand: newSession.customCommand,
      }).catch((err) => {
        console.error(`Failed to spawn split PTY session ${id}:`, err);
      });

      captureLayout(workspaceKey, workspacePath);
      return id;
    },

    restoreWorkspacePanes: async (workspacePath) => {
      const layout = useTerminalLayoutStore.getState().savedLayouts[workspacePath];
      if (!layout || layout.panes.length === 0) return;

      const limit = get().getMaxPaneLimit();
      const toRestore = layout.panes.slice(0, limit);
      const newIds: string[] = [];
      for (const pane of toRestore) {
        // Reopen the AI CLI interactively: pass provider + model but NOT a prompt file, so a
        // previous agent task is not auto-rerun. Custom-command panes re-run their command.
        const id = await get().addPane(pane.cwd, pane.aiProvider, pane.model, undefined, pane.customCommand);
        get().updateSession(id, { name: pane.name, groupColor: pane.groupColor });
        newIds.push(id);
      }

      if (layout.focusedIndex !== null && newIds[layout.focusedIndex]) {
        get().setFocusedPane(newIds[layout.focusedIndex]);
      }
      if (layout.maximizedIndex !== null && newIds[layout.maximizedIndex]) {
        get().setMaximizedPane(newIds[layout.maximizedIndex]);
      }

      // Re-snapshot once panes carry their restored names (addPane captured default labels).
      captureLayout(getActiveWorkspaceKey() || workspacePath, workspacePath);
    },

    removePane: async (paneId) => {
      const session = get().sessions[paneId];
      const workspaceKey = getWorkspaceKeyForPane(session);

      try {
        await invoke('kill_pty', { id: paneId });
      } catch (err) {
        console.error(`Error killing PTY session ${paneId}:`, err);
      }

      set((state) => {
        const panesForWorkspace = state.workspacePanes[workspaceKey] || [];
        const newPanes = panesForWorkspace.filter((pane) => pane !== paneId);
        const newSessions = { ...state.sessions };
        const newReviewPanes = { ...state.reviewPanes };

        delete newSessions[paneId];
        delete newReviewPanes[paneId];
        pendingOutputChunks.delete(paneId);
        paneOutputBuffers.delete(paneId);
        paneOutputLengths.delete(paneId);
        paneLatestSequence.delete(paneId);
        paneSignalTails.delete(paneId);
        // Normally emptied by subscribers' unsubscribe cleanup, but an error-boundary unmount
        // can skip that — drop the pane's listener set here so it can't leak.
        outputListeners.delete(paneId);

        const nextFocus = resolveFocusedPane(newPanes, state.workspaceFocusedPaneIds[workspaceKey]);
        const nextMaximized = state.workspaceMaximizedPaneIds[workspaceKey] === paneId
          ? null
          : state.workspaceMaximizedPaneIds[workspaceKey] ?? null;
        const isActiveWorkspace = getActiveWorkspaceKey() === workspaceKey;

        // When the last pane in a workspace closes, drop its map entries entirely instead
        // of leaving empty arrays / stale focus+maximized keys that accumulate as
        // workspaces are opened and closed over a session.
        const nextWorkspacePanes = { ...state.workspacePanes };
        const nextWorkspaceFocused = { ...state.workspaceFocusedPaneIds };
        const nextWorkspaceMaximized = { ...state.workspaceMaximizedPaneIds };
        if (newPanes.length === 0) {
          delete nextWorkspacePanes[workspaceKey];
          delete nextWorkspaceFocused[workspaceKey];
          delete nextWorkspaceMaximized[workspaceKey];
        } else {
          nextWorkspacePanes[workspaceKey] = newPanes;
          nextWorkspaceFocused[workspaceKey] = nextFocus;
          nextWorkspaceMaximized[workspaceKey] = nextMaximized;
        }

        return {
          panes: isActiveWorkspace ? newPanes : state.panes,
          sessions: newSessions,
          reviewPanes: newReviewPanes,
          workspacePanes: nextWorkspacePanes,
          workspaceFocusedPaneIds: nextWorkspaceFocused,
          workspaceMaximizedPaneIds: nextWorkspaceMaximized,
          focusedPaneId: isActiveWorkspace ? nextFocus : state.focusedPaneId,
          maximizedPaneId: isActiveWorkspace ? nextMaximized : state.maximizedPaneId,
        };
      });

      captureLayout(workspaceKey, session?.workspacePath);
    },

    // Tear down every pane belonging to one workspace instance. Closing a workspace from the
    // sidebar must kill its PTY child processes — otherwise the shells/agents keep running
    // (and show up in the OS task list) even though the workspace is gone. Unlike `removePane`,
    // this does NOT clear the saved layout: the snapshot captured here lets a reopened
    // workspace offer "Restore previous terminals".
    closeWorkspaceTerminals: async (workspaceKey) => {
      if (!workspaceKey) return;

      const state = get();
      const bucketPanes = state.workspacePanes[workspaceKey] || [];
      // Defensive: also catch any session that reports this workspace key but drifted out of
      // the bucket, so no PTY survives its workspace.
      const strayPanes = Object.keys(state.sessions).filter(
        (id) => !bucketPanes.includes(id) && getWorkspaceKeyForPane(state.sessions[id]) === workspaceKey,
      );
      const paneIds = [...bucketPanes, ...strayPanes];

      // Snapshot the current panes before we drop them, so reopening can restore them.
      captureLayout(workspaceKey, state.sessions[bucketPanes[0]]?.workspacePath);

      for (const paneId of paneIds) {
        try {
          await invoke('kill_pty', { id: paneId });
        } catch (err) {
          console.error(`Error killing PTY session ${paneId}:`, err);
        }
      }

      set((current) => {
        const newSessions = { ...current.sessions };
        const newReviewPanes = { ...current.reviewPanes };
        for (const paneId of paneIds) {
          delete newSessions[paneId];
          delete newReviewPanes[paneId];
          pendingOutputChunks.delete(paneId);
          paneOutputBuffers.delete(paneId);
          paneOutputLengths.delete(paneId);
          paneLatestSequence.delete(paneId);
          paneSignalTails.delete(paneId);
          outputListeners.delete(paneId);
        }

        const newWorkspacePanes = { ...current.workspacePanes };
        const newWorkspaceFocused = { ...current.workspaceFocusedPaneIds };
        const newWorkspaceMaximized = { ...current.workspaceMaximizedPaneIds };
        delete newWorkspacePanes[workspaceKey];
        delete newWorkspaceFocused[workspaceKey];
        delete newWorkspaceMaximized[workspaceKey];

        // Only blank the visible pane list if the workspace being torn down is the one on
        // screen; if the user already switched to another workspace, leave its panes intact.
        const isActiveWorkspace = getActiveWorkspaceKey() === workspaceKey;
        return {
          sessions: newSessions,
          reviewPanes: newReviewPanes,
          workspacePanes: newWorkspacePanes,
          workspaceFocusedPaneIds: newWorkspaceFocused,
          workspaceMaximizedPaneIds: newWorkspaceMaximized,
          panes: isActiveWorkspace ? [] : current.panes,
          focusedPaneId: isActiveWorkspace ? null : current.focusedPaneId,
          maximizedPaneId: isActiveWorkspace ? null : current.maximizedPaneId,
        };
      });
    },

    setFocusedPane: (paneId) => {
      const workspaceKey = paneId ? getWorkspaceKeyForPane(get().sessions[paneId]) : getActiveWorkspaceKey();
      set((state) => {
        if (!workspaceKey) return { focusedPaneId: paneId };
        return {
          focusedPaneId: getActiveWorkspaceKey() === workspaceKey ? paneId : state.focusedPaneId,
          workspaceFocusedPaneIds: { ...state.workspaceFocusedPaneIds, [workspaceKey]: paneId },
        };
      });
      if (workspaceKey) captureLayout(workspaceKey);
    },

    setMaximizedPane: (paneId) => {
      const workspaceKey = paneId ? getWorkspaceKeyForPane(get().sessions[paneId]) : getActiveWorkspaceKey();
      set((state) => {
        if (!workspaceKey) return { maximizedPaneId: paneId };
        return {
          maximizedPaneId: getActiveWorkspaceKey() === workspaceKey ? paneId : state.maximizedPaneId,
          workspaceMaximizedPaneIds: { ...state.workspaceMaximizedPaneIds, [workspaceKey]: paneId },
        };
      });
      if (workspaceKey) captureLayout(workspaceKey);
    },

    toggleMaximizePane: (paneId) => {
      const workspaceKey = getWorkspaceKeyForPane(get().sessions[paneId]);
      const current = get().workspaceMaximizedPaneIds[workspaceKey] ?? null;
      if (current === paneId) {
        get().setMaximizedPane(null);
      } else {
        get().setMaximizedPane(paneId);
        get().setFocusedPane(paneId);
      }
    },

    getMaxPaneLimit: () => useProjectStore.getState().workspaceConfig?.maxParallelAgents || DEFAULT_MAX_PANES,

    canAddPane: () => {
      const workspaceKey = getActiveWorkspaceKey();
      const panes = workspaceKey ? get().workspacePanes[workspaceKey] || [] : get().panes;
      return panes.length < get().getMaxPaneLimit();
    },

    updateSession: (paneId, updates) => set((state) => {
      const session = state.sessions[paneId];
      if (!session) return {};
      return { sessions: { ...state.sessions, [paneId]: { ...session, ...updates } } };
    }),

    setAiProvider: (paneId, provider) => {
      const session = get().sessions[paneId];
      if (!session) return;
      get().updateSession(paneId, { aiProvider: provider, name: providerLabel(provider), dynamicTitle: undefined });
      captureLayout(getWorkspaceKeyForPane(get().sessions[paneId]), session.workspacePath);
    },

    // Record a command the user actually typed (one full line, committed on Enter — see
    // TerminalPane.onData). Called rarely (per command, not per output frame), so the single
    // set() here is cheap and only ever reflects real input, never echoed shell output.
    recordCommand: (paneId, command) => {
      const clean = command.trim();
      if (!clean || clean.length >= 200) return;
      if (!get().sessions[paneId]) return;

      set((state) => {
        const currentSession = state.sessions[paneId];
        if (!currentSession) return {};
        const blocks = [...(currentSession.commandBlocks || [])].slice(-MAX_COMMAND_BLOCKS);
        if (blocks.length > 0 && !blocks[blocks.length - 1].endedAt) {
          blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], endedAt: new Date().toISOString() };
        }

        return {
          sessions: {
            ...state.sessions,
            [paneId]: {
              ...currentSession,
              lastCommandInput: clean,
              commandBlocks: [
                ...blocks,
                { id: createId('cmd'), command: clean, startedAt: new Date().toISOString(), outputPreview: '' },
              ].slice(-MAX_COMMAND_BLOCKS),
            },
          },
        };
      });
    },

    requestReview: (paneId) => set((state) => (
      state.reviewPanes[paneId] ? {} : { reviewPanes: { ...state.reviewPanes, [paneId]: true } }
    )),

    resolveReview: (paneId) => set((state) => {
      const newReviews = { ...state.reviewPanes };
      delete newReviews[paneId];
      return { reviewPanes: newReviews };
    }),

    clearAll: async () => {
      const panes = Object.keys(get().sessions);
      for (const paneId of panes) {
        try {
          await invoke('kill_pty', { id: paneId });
        } catch {
          // Ignore kill failures during cleanup.
        }
      }
      pendingOutputChunks.clear();
      paneOutputBuffers.clear();
      paneOutputLengths.clear();
      paneLatestSequence.clear();
      paneSignalTails.clear();
      cancelScheduledOutputFlush();
      set({
        panes: [],
        sessions: {},
        focusedPaneId: null,
        maximizedPaneId: null,
        reviewPanes: {},
        workspacePanes: {},
        workspaceFocusedPaneIds: {},
        workspaceMaximizedPaneIds: {},
      });
    },
  };
});
