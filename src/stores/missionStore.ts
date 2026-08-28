import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { toErrorMessage } from '../lib/errors';
import type {
  ArtifactPublishInput,
  AskInput,
  AskOutcome,
  GateRequestInput,
  MissionCommand,
  MissionCreateInput,
  MissionMessage,
  MissionReadResult,
  MissionState,
  MissionSummary,
  ProviderAdapterDto,
  SendMessageInput,
  SettlementOutcome,
  StepReport,
  TaskDispatchOutput,
  TaskSpecInput,
} from '../types/mission';

// Missions room projection (Phase M1/M2/M3/M4). React never writes mission state directly: every
// mutation goes through the engine commands in src-tauri/src/missions.rs, and this store
// only folds command results back into memory.

interface MissionStoreState {
  missions: MissionSummary[];
  adapters: ProviderAdapterDto[];
  loadedProjectPath: string | null;
  requestedProjectPath: string | null;
  loading: boolean;
  error: string | null;

  activeId: string | null;
  activeProjectPath: string | null;
  activeState: MissionState | null;
  activeDoc: string | null;
  // Non-fatal reconcile-on-read notes from the last load of the active mission.
  activeWarnings: string[];
  activeLoading: boolean;

  loadMissions: (projectPath: string, force?: boolean) => Promise<void>;
  loadAdapters: () => Promise<void>;
  openMission: (projectPath: string, id: string) => Promise<void>;
  closeMission: () => void;
  createMission: (projectPath: string, input: MissionCreateInput) => Promise<string>;
  saveDoc: (
    projectPath: string,
    id: string,
    body: string,
    expectedRevision: number,
  ) => Promise<void>;
  saveTasks: (
    projectPath: string,
    id: string,
    expectedRevision: number,
    tasks: TaskSpecInput[],
  ) => Promise<void>;
  dispatchTask: (
    projectPath: string,
    missionId: string,
    taskId: string,
    provider: string,
    model?: string,
  ) => Promise<TaskDispatchOutput>;
  recordDispatchResult: (
    projectPath: string,
    missionId: string,
    dispatchId: string,
    rawOutput: string,
    lastMessageContent?: string,
  ) => Promise<MissionState>;
  runCommand: (projectPath: string, id: string, cmd: MissionCommand) => Promise<void>;
  tick: (projectPath: string, missionId: string) => Promise<MissionState>;
  recover: (projectPath: string) => Promise<MissionSummary[]>;
  retryDispatch: (projectPath: string, missionId: string, dispatchId: string) => Promise<void>;
  abandonDispatch: (projectPath: string, missionId: string, dispatchId: string) => Promise<void>;

  // Phase M4 Actions
  requestGate: (
    projectPath: string,
    missionId: string,
    input: GateRequestInput,
  ) => Promise<MissionState>;
  resolveGate: (
    projectPath: string,
    missionId: string,
    gateId: string,
    resolution: string,
  ) => Promise<MissionState>;
  ask: (projectPath: string, missionId: string, input: AskInput) => Promise<AskOutcome>;
  reply: (
    projectPath: string,
    missionId: string,
    threadId: string,
    body: string,
  ) => Promise<MissionState>;
  sendMessage: (
    projectPath: string,
    missionId: string,
    input: SendMessageInput,
  ) => Promise<MissionState>;
  fetchInbox: (
    projectPath: string,
    missionId: string,
    recipient: string,
  ) => Promise<MissionMessage[]>;
  ackInbox: (
    projectPath: string,
    missionId: string,
    messageIds: string[],
  ) => Promise<MissionState>;
  publishArtifact: (
    projectPath: string,
    missionId: string,
    input: ArtifactPublishInput,
  ) => Promise<MissionState>;
  settleReport: (
    projectPath: string,
    missionId: string,
    report: StepReport,
  ) => Promise<SettlementOutcome>;
}

// Currency tokens so overlapping loads (rapid switches, watcher bursts, focus polls)
// can never commit another mission's data into the current view.
let listSeq = 0;
let activeSeq = 0;
let mutationSeq = 0;

export const useMissionStore = create<MissionStoreState>((set, get) => ({
  missions: [],
  adapters: [],
  loadedProjectPath: null,
  requestedProjectPath: null,
  loading: false,
  error: null,

  activeId: null,
  activeProjectPath: null,
  activeState: null,
  activeDoc: null,
  activeWarnings: [],
  activeLoading: false,

  // Always re-fetch: the list read is cheap, focus polling relies on it, and the seq
  // token below discards any response that loses a race against a newer request.
  loadMissions: async (projectPath) => {
    const current = get();
    if (
      (current.requestedProjectPath && current.requestedProjectPath !== projectPath) ||
      (current.loadedProjectPath && current.loadedProjectPath !== projectPath) ||
      (current.activeProjectPath && current.activeProjectPath !== projectPath)
    ) {
      activeSeq += 1;
      mutationSeq += 1;
      set({
        missions: [],
        loadedProjectPath: null,
        activeId: null,
        activeProjectPath: null,
        activeState: null,
        activeDoc: null,
        activeWarnings: [],
        activeLoading: false,
      });
    }
    set({ requestedProjectPath: projectPath });
    const token = ++listSeq;
    set({ loading: true, error: null });
    try {
      const missions = await invoke<MissionSummary[]>('mission_list', { projectPath });
      if (token !== listSeq) return;
      set({ missions, loadedProjectPath: projectPath, loading: false, error: null });
    } catch (err) {
      if (token !== listSeq) return;
      set({ error: toErrorMessage(err), loading: false });
    }
  },

  openMission: async (projectPath, id) => {
    const requestedProjectPath = get().requestedProjectPath;
    if (requestedProjectPath && requestedProjectPath !== projectPath) return;
    const current = get();
    const sameMission = current.activeId === id && current.activeProjectPath === projectPath;
    const token = ++activeSeq;
    set({
      activeId: id,
      activeProjectPath: projectPath,
      activeState: sameMission ? current.activeState : null,
      activeDoc: sameMission ? current.activeDoc : null,
      activeLoading: true,
      activeWarnings: [],
      error: null,
    });
    try {
      const result = await invoke<MissionReadResult>('mission_read', { projectPath, id });
      if (token !== activeSeq) return;
      switch (result.status) {
        case 'loaded':
          set({
            activeState: result.state,
            activeDoc: result.doc,
            activeWarnings: result.warnings,
            activeLoading: false,
          });
          break;
        case 'missing':
          set({ activeState: null, activeDoc: null, activeLoading: false });
          break;
        case 'corrupt':
          set({
            activeState: null,
            activeDoc: null,
            activeLoading: false,
            error: `${result.error} (preserved copy: ${result.backupPath})`,
          });
          break;
        case 'locked':
          set({
            activeState: null,
            activeDoc: null,
            activeLoading: false,
            error: 'Mission state is locked by another process; retry shortly.',
          });
          break;
      }
    } catch (err) {
      if (token !== activeSeq) return;
      set({ activeState: null, activeDoc: null, activeLoading: false, error: toErrorMessage(err) });
    }
  },

  closeMission: () => {
    activeSeq += 1;
    mutationSeq += 1;
    set({
      activeId: null,
      activeProjectPath: null,
      activeState: null,
      activeDoc: null,
      activeWarnings: [],
      activeLoading: false,
    });
  },

  createMission: async (projectPath, input) => {
    const activeToken = activeSeq;
    ++listSeq;
    try {
      const summary = await invoke<MissionSummary>('mission_create', {
        projectPath,
        title: input.title,
        objective: input.objective,
        acceptance: input.options?.acceptance ?? null,
        options: input.options ?? null,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        (current.requestedProjectPath && current.requestedProjectPath !== projectPath) ||
        (current.loadedProjectPath && current.loadedProjectPath !== projectPath) ||
        (current.activeProjectPath && current.activeProjectPath !== projectPath)
      ) {
        return summary.id;
      }
      await get().loadMissions(projectPath, true);
      if (
        activeToken !== activeSeq ||
        (get().requestedProjectPath && get().requestedProjectPath !== projectPath) ||
        (get().loadedProjectPath && get().loadedProjectPath !== projectPath) ||
        (get().activeProjectPath && get().activeProjectPath !== projectPath)
      ) {
        return summary.id;
      }
      await get().openMission(projectPath, summary.id);
      return summary.id;
    } catch (err) {
      if (activeToken === activeSeq) {
        set({ error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  saveDoc: async (projectPath, id, body, expectedRevision) => {
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const state = await invoke<MissionState>('mission_update_doc', {
        projectPath,
        id,
        body,
        expectedRevision,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== id ||
        current.activeProjectPath !== projectPath
      )
        return;
      set({
        activeState: state,
        activeDoc: body,
        activeWarnings: [],
        activeLoading: false,
        error: null,
      });
      await get().loadMissions(projectPath, true);
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === id &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  saveTasks: async (projectPath, id, expectedRevision, tasks) => {
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const state = await invoke<MissionState>('mission_set_tasks', {
        projectPath,
        id,
        expectedRevision,
        tasks,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== id ||
        current.activeProjectPath !== projectPath
      )
        return;
      set({ activeState: state, activeLoading: false, error: null });
      await get().loadMissions(projectPath, true);
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === id &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  loadAdapters: async () => {
    try {
      const adapters = await invoke<ProviderAdapterDto[]>('get_provider_adapters');
      set({ adapters });
    } catch (err) {
      console.error('Failed to load provider adapters', err);
    }
  },

  dispatchTask: async (projectPath, missionId, taskId, provider, model) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const out = await invoke<TaskDispatchOutput>('mission_dispatch_task', {
        projectPath,
        missionId,
        taskId,
        provider,
        model: model ?? null,
        expectedRevision,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== missionId ||
        current.activeProjectPath !== projectPath
      ) {
        return out;
      }
      set({ activeState: out.state, activeLoading: false, error: null });
      await get().loadMissions(projectPath, true);
      return out;
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === missionId &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  recordDispatchResult: async (projectPath, missionId, dispatchId, rawOutput, lastMessageContent) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const state = await invoke<MissionState>('mission_record_dispatch_result', {
        projectPath,
        missionId,
        dispatchId,
        rawOutput,
        lastMessageContent: lastMessageContent ?? null,
        expectedRevision,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== missionId ||
        current.activeProjectPath !== projectPath
      ) {
        return state;
      }
      set({ activeState: state, activeLoading: false, error: null });
      await get().loadMissions(projectPath, true);
      return state;
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === missionId &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  runCommand: async (projectPath, id, cmd) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const state = await invoke<MissionState>('mission_command', {
        projectPath,
        id,
        expectedRevision,
        requestId: `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        cmd,
      });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== id ||
        current.activeProjectPath !== projectPath
      )
        return;
      set({ activeState: state, activeLoading: false, error: null });
      await get().loadMissions(projectPath, true);
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === id &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  tick: async (projectPath, missionId) => {
    const activeToken = ++activeSeq;
    const mutationToken = ++mutationSeq;
    try {
      const state = await invoke<MissionState>('mission_tick', { projectPath, missionId });
      const current = get();
      if (
        activeToken !== activeSeq ||
        mutationToken !== mutationSeq ||
        current.activeId !== missionId ||
        current.activeProjectPath !== projectPath
      ) {
        return state;
      }
      set({ activeState: state, activeLoading: false, error: null });
      await get().loadMissions(projectPath, true);
      return state;
    } catch (err) {
      if (
        activeToken === activeSeq &&
        mutationToken === mutationSeq &&
        get().activeId === missionId &&
        get().activeProjectPath === projectPath
      ) {
        set({ activeLoading: false, error: toErrorMessage(err) });
      }
      throw err;
    }
  },

  recover: async (projectPath) => {
    try {
      const summaries = await invoke<MissionSummary[]>('mission_recover', { projectPath });
      set({ missions: summaries, loadedProjectPath: projectPath });
      const activeId = get().activeId;
      if (activeId) {
        await get().openMission(projectPath, activeId);
      }
      return summaries;
    } catch (err) {
      set({ error: toErrorMessage(err) });
      throw err;
    }
  },

  retryDispatch: async (projectPath, missionId, dispatchId) => {
    return get().runCommand(projectPath, missionId, { type: 'retry', dispatchId });
  },

  abandonDispatch: async (projectPath, missionId, dispatchId) => {
    return get().runCommand(projectPath, missionId, { type: 'abandon', dispatchId });
  },

  requestGate: async (projectPath, missionId, input) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_request_gate', {
      projectPath,
      missionId,
      input,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    return state;
  },

  resolveGate: async (projectPath, missionId, gateId, resolution) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_resolve_gate', {
      projectPath,
      missionId,
      gateId,
      resolution,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    await get().loadMissions(projectPath, true);
    return state;
  },

  ask: async (projectPath, missionId, input) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const outcome = await invoke<AskOutcome>('mission_ask', {
      projectPath,
      missionId,
      input,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: outcome.state, error: null });
    }
    return outcome;
  },

  reply: async (projectPath, missionId, threadId, body) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_reply', {
      projectPath,
      missionId,
      threadId,
      body,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    return state;
  },

  sendMessage: async (projectPath, missionId, input) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_send_message', {
      projectPath,
      missionId,
      input,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    return state;
  },

  fetchInbox: async (projectPath, missionId, recipient) => {
    return invoke<MissionMessage[]>('mission_inbox_fetch', {
      projectPath,
      missionId,
      recipient,
    });
  },

  ackInbox: async (projectPath, missionId, messageIds) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_inbox_ack', {
      projectPath,
      missionId,
      messageIds,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    return state;
  },

  publishArtifact: async (projectPath, missionId, input) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const state = await invoke<MissionState>('mission_publish_artifact', {
      projectPath,
      missionId,
      input,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: state, error: null });
    }
    return state;
  },

  settleReport: async (projectPath, missionId, report) => {
    const expectedRevision = get().activeState?.revision ?? 0;
    const outcome = await invoke<SettlementOutcome>('mission_settle_report', {
      projectPath,
      missionId,
      report,
      expectedRevision,
    });
    if (get().activeId === missionId) {
      set({ activeState: outcome.state, error: null });
    }
    await get().loadMissions(projectPath, true);
    return outcome;
  },
}));
