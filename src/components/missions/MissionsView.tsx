import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Database,
  Flag,
  FolderOpen,
  HelpCircle,
  ListChecks,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Send,
  ShieldAlert,
  Square,
  Trash2,
  XCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../stores/projectStore';
import { useMissionStore } from '../../stores/missionStore';
import { useNotificationStore } from '../../stores/notificationStore';
import type { MissionState, MissionSummary, TaskKind, TaskSpecInput } from '../../types/mission';

// Missions room projection (Phase M1/M2/M3). React never writes mission state directly: every
// mutation goes through the engine commands in src-tauri/src/missions.rs, and this store
// only folds command results back into memory.

interface TaskDraft {
  key: string;
  title: string;
  kind: TaskKind;
  spec: string;
  deps: string[];
}

const TASK_KINDS: TaskKind[] = ['implement', 'review', 'verify'];

const STATUS_ORDER: Record<
  MissionState['status'],
  Array<{ cmd: 'start' | 'pause' | 'resume' | 'cancel'; label: string; icon: React.ElementType }>
> = {
  draft: [
    { cmd: 'start', label: 'Start', icon: Play },
    { cmd: 'cancel', label: 'Cancel', icon: Square },
  ],
  running: [
    { cmd: 'pause', label: 'Pause', icon: Pause },
    { cmd: 'cancel', label: 'Cancel', icon: Square },
  ],
  paused: [
    { cmd: 'resume', label: 'Resume', icon: Play },
    { cmd: 'cancel', label: 'Cancel', icon: Square },
  ],
  gated: [{ cmd: 'pause', label: 'Pause', icon: Pause }],
  completed: [],
  failed: [],
  cancelled: [],
};

// Map persisted server-id deps onto the picker's stable per-index keys so editing a
// saved graph never silently drops its edges.
const draftsFromTasks = (tasks: MissionState['tasks']): TaskDraft[] =>
  tasks.map((task, i) => ({
    key: `t${i + 1}`,
    title: task.title,
    kind: task.kind,
    spec: task.spec,
    deps: task.deps
      .map((depId) => {
        const idx = tasks.findIndex((t) => t.id === depId);
        return idx === -1 ? null : `t${idx + 1}`;
      })
      .filter((key): key is string => key !== null),
  }));

export const MissionsView: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const openWorkspace = useProjectStore((state) => state.openWorkspace);
  const setActiveView = useProjectStore((state) => state.setActiveView);

  const missions = useMissionStore((state) => state.missions);
  const adapters = useMissionStore((state) => state.adapters);
  const loading = useMissionStore((state) => state.loading);
  const error = useMissionStore((state) => state.error);
  const loadMissions = useMissionStore((state) => state.loadMissions);
  const loadAdapters = useMissionStore((state) => state.loadAdapters);
  const activeId = useMissionStore((state) => state.activeId);
  const activeState = useMissionStore((state) => state.activeState);
  const activeDoc = useMissionStore((state) => state.activeDoc);
  const activeWarnings = useMissionStore((state) => state.activeWarnings);
  const openMission = useMissionStore((state) => state.openMission);
  const retryDispatch = useMissionStore((state) => state.retryDispatch);
  const abandonDispatch = useMissionStore((state) => state.abandonDispatch);
  const tickMission = useMissionStore((state) => state.tick);
  const resolveGate = useMissionStore((state) => state.resolveGate);
  const replyAsk = useMissionStore((state) => state.reply);
  const sendMessage = useMissionStore((state) => state.sendMessage);

  // Doc editor buffer. Kept local so typing never touches the engine until Save.
  const [docBuffer, setDocBuffer] = useState('');
  const [docDirty, setDocDirty] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState<TaskDraft[]>([]);
  const [tasksDirty, setTasksDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dispatchingTask, setDispatchingTask] = useState<string | null>(null);
  const [selectedProviders, setSelectedProviders] = useState<Record<string, string>>({});
  const [replyBuffers, setReplyBuffers] = useState<Record<string, string>>({});
  const [composeBody, setComposeBody] = useState('');
  const docBufferRef = useRef(docBuffer);
  const taskDraftsRef = useRef(taskDrafts);
  docBufferRef.current = docBuffer;
  taskDraftsRef.current = taskDrafts;

  const pendingAsks = useMemo(() => {
    if (!activeState?.messages) return [];
    return activeState.messages.filter((m) => m.kind === 'ask' && m.expectsReply && !m.answeredBy);
  }, [activeState?.messages]);

  useEffect(() => {
    void loadAdapters();
  }, [loadAdapters]);

  useEffect(() => {
    if (currentProjectPath) void loadMissions(currentProjectPath);
  }, [currentProjectPath, loadMissions]);

  // Focus polling / refresh
  useEffect(() => {
    if (!currentProjectPath) return;
    const onFocus = () => {
      void loadMissions(currentProjectPath);
      const id = useMissionStore.getState().activeId;
      if (id) void openMission(currentProjectPath, id);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [currentProjectPath, loadMissions, openMission]);

  // Reset local buffers on mission switch.
  useEffect(() => {
    setDocBuffer(activeDoc ?? '');
    setDocDirty(false);
    setTaskDrafts(activeState ? draftsFromTasks(activeState.tasks) : []);
    setTasksDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Follow engine truth while the operator has no unsaved local edits
  useEffect(() => {
    if (!docDirty) setDocBuffer(activeDoc ?? '');
  }, [activeDoc, docDirty]);

  useEffect(() => {
    if (!tasksDirty && activeState) setTaskDrafts(draftsFromTasks(activeState.tasks));
  }, [activeState, tasksDirty]);

  const handleOpenProject = async () => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        await openWorkspace(selectedPath);
        setActiveView('missions');
      }
    } catch (err) {
      console.error('Failed to select directory:', err);
    }
  };

  const handleCreateMission = async () => {
    if (!currentProjectPath) return;
    setCreating(true);
    try {
      await useMissionStore.getState().createMission(currentProjectPath, {
        title: 'New Mission',
        objective: 'Describe the objective the coordinator should decompose.',
      });
    } catch {
      // Error surfaced through the store banner.
    } finally {
      setCreating(false);
    }
  };

  const handleSaveDoc = async () => {
    if (!currentProjectPath || !activeId || !activeState) return;
    const submittedPath = currentProjectPath;
    const submittedId = activeId;
    const submittedDoc = docBuffer;
    try {
      await useMissionStore
        .getState()
        .saveDoc(submittedPath, submittedId, submittedDoc, activeState.revision);
      const current = useMissionStore.getState();
      if (
        current.activeId === submittedId &&
        current.activeProjectPath === submittedPath &&
        docBufferRef.current === submittedDoc
      ) {
        setDocDirty(false);
        useNotificationStore.getState().success('Mission document saved');
      }
    } catch {
      // Error surfaced through the store banner (validation or revision conflict).
    }
  };

  const handleSaveTasks = async () => {
    if (!currentProjectPath || !activeId || !activeState) return;
    const submittedPath = currentProjectPath;
    const submittedId = activeId;
    const submittedDrafts = taskDrafts;
    const specs: TaskSpecInput[] = taskDrafts.map((draft) => ({
      key: draft.key,
      title: draft.title.trim() || 'Untitled task',
      kind: draft.kind,
      spec: draft.spec,
      deps: draft.deps.filter((dep) => dep !== draft.key && taskDrafts.some((d) => d.key === dep)),
      fanout: 1,
    }));
    try {
      await useMissionStore
        .getState()
        .saveTasks(submittedPath, submittedId, activeState.revision, specs);
      const current = useMissionStore.getState();
      if (
        current.activeId === submittedId &&
        current.activeProjectPath === submittedPath &&
        taskDraftsRef.current === submittedDrafts
      ) {
        setTasksDirty(false);
        useNotificationStore.getState().success('Task graph saved');
      }
    } catch {
      // Validation errors surface in the store banner.
    }
  };

  const updateDraft = useCallback((index: number, patch: Partial<TaskDraft>) => {
    setTaskDrafts((prev) => prev.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
    setTasksDirty(true);
  }, []);

  const toggleDep = useCallback((index: number, key: string) => {
    setTaskDrafts((prev) =>
      prev.map((draft, i) => {
        if (i !== index) return draft;
        const has = draft.deps.includes(key);
        return { ...draft, deps: has ? draft.deps.filter((d) => d !== key) : [...draft.deps, key] };
      }),
    );
    setTasksDirty(true);
  }, []);

  const handleDispatchTask = async (taskId: string, provider: string, model?: string) => {
    if (!currentProjectPath || !activeState) return;
    setDispatchingTask(taskId);
    try {
      const out = await useMissionStore
        .getState()
        .dispatchTask(currentProjectPath, activeState.id, taskId, provider, model);
      useNotificationStore
        .getState()
        .success(`Dispatched task with ${provider} (${out.attemptId})`);
    } catch (err) {
      useNotificationStore.getState().error(`Failed to dispatch: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDispatchingTask(null);
    }
  };

  const handleTick = async () => {
    if (!currentProjectPath || !activeId) return;
    try {
      await tickMission(currentProjectPath, activeId);
      useNotificationStore.getState().success('Scheduler tick executed');
    } catch (err) {
      useNotificationStore.getState().error(`Tick failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleRetryDispatch = async (dispatchId: string) => {
    if (!currentProjectPath || !activeId) return;
    try {
      await retryDispatch(currentProjectPath, activeId, dispatchId);
      useNotificationStore.getState().success('Dispatch marked for retry');
    } catch (err) {
      useNotificationStore.getState().error(`Retry failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAbandonDispatch = async (dispatchId: string) => {
    if (!currentProjectPath || !activeId) return;
    try {
      await abandonDispatch(currentProjectPath, activeId, dispatchId);
      useNotificationStore.getState().success('Dispatch abandoned');
    } catch (err) {
      useNotificationStore.getState().error(`Abandon failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleResolveGate = async (gateId: string, resolution: string) => {
    if (!currentProjectPath || !activeId) return;
    try {
      await resolveGate(currentProjectPath, activeId, gateId, resolution);
      useNotificationStore.getState().success(`Gate resolved: ${resolution}`);
    } catch (err) {
      useNotificationStore.getState().error(`Failed to resolve gate: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReplyAsk = async (threadId: string) => {
    if (!currentProjectPath || !activeId) return;
    const body = (replyBuffers[threadId] || '').trim();
    if (!body) return;
    try {
      await replyAsk(currentProjectPath, activeId, threadId, body);
      setReplyBuffers((prev) => ({ ...prev, [threadId]: '' }));
      useNotificationStore.getState().success('Reply sent');
    } catch (err) {
      useNotificationStore.getState().error(`Failed to send reply: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSendMessage = async () => {
    if (!currentProjectPath || !activeId) return;
    const body = composeBody.trim();
    if (!body) return;
    try {
      await sendMessage(currentProjectPath, activeId, {
        from: 'operator',
        to: 'all',
        kind: 'message',
        body,
      });
      setComposeBody('');
      useNotificationStore.getState().success('Message posted to mission mailbox');
    } catch (err) {
      useNotificationStore.getState().error(`Failed to send message: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const lifecycleActions = useMemo(
    () => (activeState ? (STATUS_ORDER[activeState.status] ?? []) : []),
    [activeState],
  );

  if (!currentProjectPath) {
    return (
      <div className="missions-empty-state">
        <div className="missions-empty-card">
          <FolderOpen size={40} />
          <h3>No Workspace Active</h3>
          <p>Open a workspace directory to plan multi-agent missions.</p>
          <button onClick={handleOpenProject} className="primary">
            Open Workspace
          </button>
        </div>
      </div>
    );
  }

  const renderSummary = (summary: MissionSummary) => (
    <button
      key={summary.id}
      className={`missions-summary${summary.id === activeId ? ' active' : ''}`}
      onClick={() => currentProjectPath && void openMission(currentProjectPath, summary.id)}
      title={summary.title}
    >
      <span className="missions-summary-title">{summary.title}</span>
      <span className="missions-summary-meta">
        <span className={`mission-status-badge ${summary.status}`}>{summary.status}</span>
        <span>
          {summary.taskCompleted}/{summary.taskTotal} tasks
        </span>
      </span>
    </button>
  );

  return (
    <div className="missions-workspace">
      <aside className="missions-list" aria-label="Missions">
        <div className="missions-list-heading">
          <Flag size={15} />
          <span>Missions</span>
          <button
            className="missions-new-button"
            onClick={handleCreateMission}
            disabled={creating}
            title="Create a new mission"
          >
            <Plus size={13} />
            New
          </button>
        </div>
        {loading && missions.length === 0 ? (
          <div className="missions-empty-list">Loading missions...</div>
        ) : missions.length === 0 ? (
          <div className="missions-empty-list">
            No missions yet. Create one to plan an objective as durable markdown plus a task graph.
          </div>
        ) : (
          missions.map(renderSummary)
        )}
      </aside>

      <div className="missions-detail" aria-label="Mission detail">
        {error && (
          <div role="alert" className="missions-error-banner">
            <AlertTriangle size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {error}
          </div>
        )}

        {!activeState ? (
          <div className="missions-empty-card">
            <ListChecks size={32} />
            <h3>No Mission Selected</h3>
            <p>Select a mission on the left, or create a new one to start planning.</p>
            <button onClick={handleCreateMission} disabled={creating}>
              <Plus size={14} /> New Mission
            </button>
          </div>
        ) : (
          <>
            <div className="missions-detail-header">
              <h2 className="missions-detail-title">{activeState.spec.title}</h2>
              <span className={`mission-status-badge ${activeState.status}`}>
                {activeState.status}
              </span>
              <span className="missions-revision">rev {activeState.revision}</span>
              {lifecycleActions.map(({ cmd, label, icon: Icon }) => (
                <button
                  key={cmd}
                  onClick={() =>
                    currentProjectPath &&
                    void useMissionStore
                      .getState()
                      .runCommand(currentProjectPath, activeState.id, { type: cmd })
                  }
                  title={label}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
              {activeState.status === 'running' && (
                <button onClick={handleTick} title="Run scheduler tick" aria-label="Run scheduler tick">
                  <RefreshCw size={13} />
                  <span>Tick</span>
                </button>
              )}
              <button
                onClick={() => currentProjectPath && void loadMissions(currentProjectPath, true)}
                title="Reload from disk"
                aria-label="Reload missions from disk"
              >
                <RotateCw size={13} />
              </button>
            </div>

            {activeWarnings.length > 0 && (
              <div role="status" className="missions-warning-banner">
                {activeWarnings.map((warning, i) => (
                  <p key={i} style={{ margin: 0 }}>
                    {warning}
                  </p>
                ))}
              </div>
            )}

            <section className="missions-section">
              <div className="missions-section-heading">
                <span>mission.md</span>
                <div className="missions-section-actions">
                  <button onClick={handleSaveDoc} disabled={!docDirty} title="Save document">
                    <Save size={13} />
                    <span>{docDirty ? 'Save' : 'Saved'}</span>
                  </button>
                </div>
              </div>
              <textarea
                className="missions-doc-editor"
                value={docBuffer}
                onChange={(e) => {
                  setDocBuffer(e.target.value);
                  setDocDirty(true);
                }}
                spellCheck={false}
                aria-label="Mission markdown editor"
              />
            </section>

            <section className="missions-section">
              <div className="missions-section-heading">
                <span>Tasks ({activeState.tasks.length})</span>
                <div className="missions-section-actions">
                  <button
                    onClick={() => {
                      setTaskDrafts((prev) => [
                        ...prev,
                        {
                          key: `t${Date.now().toString(36)}`,
                          title: '',
                          kind: 'implement',
                          spec: '',
                          deps: [],
                        },
                      ]);
                      setTasksDirty(true);
                    }}
                    title="Add task"
                  >
                    <Plus size={13} />
                    <span>Add task</span>
                  </button>
                  <button onClick={handleSaveTasks} disabled={!tasksDirty} title="Save task graph">
                    <Save size={13} />
                    <span>{tasksDirty ? 'Save tasks' : 'Saved'}</span>
                  </button>
                </div>
              </div>

              {taskDrafts.length === 0 ? (
                <div className="missions-empty-tasks">
                  No tasks yet. Decompose the objective into tasks with dependencies - independent
                  tasks start ready, the rest wait for their dependencies.
                </div>
              ) : (
                <table className="missions-spec-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Kind</th>
                      <th>Instructions</th>
                      <th>Depends on</th>
                      <th>Status & Dispatch</th>
                      <th aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {taskDrafts.map((draft, index) => {
                      const serverTask = activeState.tasks[index];
                      const providerOptions = adapters.filter((a) => a.isMissionEligible);
                      const currentProvider =
                        selectedProviders[serverTask?.id || draft.key] ||
                        activeState.spec.coordinator?.provider ||
                        (providerOptions[0]?.id ?? 'codex');

                      return (
                        <tr key={draft.key}>
                          <td>
                            <input
                              className="missions-task-title"
                              value={draft.title}
                              onChange={(e) => updateDraft(index, { title: e.target.value })}
                              placeholder="Task title"
                              aria-label={`Task ${index + 1} title`}
                            />
                          </td>
                          <td>
                            <select
                              value={draft.kind}
                              onChange={(e) =>
                                updateDraft(index, { kind: e.target.value as TaskKind })
                              }
                              aria-label={`Task ${index + 1} kind`}
                            >
                              {TASK_KINDS.map((kind) => (
                                <option key={kind} value={kind}>
                                  {kind}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <input
                              className="missions-task-spec"
                              value={draft.spec}
                              onChange={(e) => updateDraft(index, { spec: e.target.value })}
                              placeholder="Full instructions handed to the worker"
                              aria-label={`Task ${index + 1} instructions`}
                            />
                          </td>
                          <td>
                            <div className="missions-deps-cell">
                              {taskDrafts
                                .filter((other) => other.key !== draft.key)
                                .map((other) => (
                                  <button
                                    key={other.key}
                                    className={`missions-dep-chip${draft.deps.includes(other.key) ? ' selected' : ''}`}
                                    onClick={() => toggleDep(index, other.key)}
                                    title={
                                      draft.deps.includes(other.key)
                                        ? 'Remove dependency'
                                        : 'Add dependency'
                                    }
                                  >
                                    {other.title || 'untitled'}
                                  </button>
                                ))}
                            </div>
                          </td>
                          <td>
                            {serverTask ? (
                              <div className="missions-task-actions">
                                <span className={`task-status-chip ${serverTask.status}`}>
                                  {serverTask.status}
                                </span>
                                {!tasksDirty && serverTask.id && (
                                  <>
                                    <select
                                      className="missions-provider-select"
                                      value={currentProvider}
                                      onChange={(e) =>
                                        setSelectedProviders((prev) => ({
                                          ...prev,
                                          [serverTask.id]: e.target.value,
                                        }))
                                      }
                                      title="Dispatch provider"
                                      aria-label={`Provider for task ${index + 1}`}
                                    >
                                      {providerOptions.length > 0 ? (
                                        providerOptions.map((ad) => (
                                          <option key={ad.id} value={ad.id}>
                                            {ad.id}
                                          </option>
                                        ))
                                      ) : (
                                        <>
                                          <option value="codex">codex</option>
                                          <option value="claude">claude</option>
                                          <option value="droid">droid</option>
                                          <option value="gemini">gemini</option>
                                          <option value="grok">grok</option>
                                          <option value="opencode">opencode</option>
                                        </>
                                      )}
                                    </select>
                                    <button
                                      className="missions-dispatch-btn"
                                      disabled={
                                        dispatchingTask === serverTask.id ||
                                        (serverTask.status !== 'ready' &&
                                          serverTask.status !== 'pending' &&
                                          serverTask.status !== 'failed')
                                      }
                                      onClick={() => handleDispatchTask(serverTask.id, currentProvider)}
                                      title="Dispatch worker for this task"
                                    >
                                      <Play size={10} />
                                      <span>Dispatch</span>
                                    </button>
                                  </>
                                )}
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                                Unsaved
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              onClick={() => {
                                setTaskDrafts((prev) => prev.filter((_, i) => i !== index));
                                setTasksDirty(true);
                              }}
                              title={`Remove task ${draft.title || index + 1}`}
                              aria-label={`Remove task ${draft.title || index + 1}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>

            {activeState.pool && activeState.pool.length > 0 && (
              <section className="missions-section">
                <div className="missions-section-heading">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Database size={13} />
                    <span>Session Pool ({activeState.pool.length})</span>
                  </span>
                </div>
                <table className="missions-spec-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th>Model</th>
                      <th>Session ID</th>
                      <th>State</th>
                      <th>Reuses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeState.pool.map((entry, i) => (
                      <tr key={`${entry.key}_${i}`}>
                        <td>{entry.provider}</td>
                        <td>{entry.model}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                          {entry.sessionId}
                        </td>
                        <td>
                          <span className={`mission-status-badge ${entry.state}`}>
                            {entry.state}
                          </span>
                        </td>
                        <td>{entry.reusedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {activeState.dispatches && activeState.dispatches.length > 0 && (
              <section className="missions-section">
                <div className="missions-section-heading">
                  <span>Dispatches & Results ({activeState.dispatches.length})</span>
                </div>
                <table className="missions-spec-table">
                  <thead>
                    <tr>
                      <th>Attempt</th>
                      <th>Task</th>
                      <th>Provider / Model</th>
                      <th>Status</th>
                      <th>Started</th>
                      <th>Result & Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeState.dispatches.map((dispatch) => {
                      const associatedTask = activeState.tasks.find((t) => t.id === dispatch.taskId);
                      const isUnknownOrFailed =
                        dispatch.status === 'failed' ||
                        dispatch.status === 'stop_unknown' ||
                        dispatch.status === 'starting_unknown';

                      return (
                        <tr key={dispatch.id}>
                          <td>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>
                              {dispatch.attemptId}
                            </span>
                            {dispatch.retryOf && (
                              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '10px' }}>
                                retry of {dispatch.retryOf.slice(0, 8)}
                              </span>
                            )}
                          </td>
                          <td>{associatedTask?.title || dispatch.taskId}</td>
                          <td>
                            <span>{dispatch.provider}</span>
                            {dispatch.model && dispatch.model !== 'default' && (
                              <span style={{ color: 'var(--text-muted)', marginLeft: 4 }}>
                                ({dispatch.model})
                              </span>
                            )}
                          </td>
                          <td>
                            <span className={`mission-status-badge ${dispatch.status}`}>
                              {dispatch.status}
                            </span>
                            {dispatch.terminationReason && (
                              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '10px' }}>
                                {dispatch.terminationReason}
                              </span>
                            )}
                          </td>
                          <td style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                            {dispatch.startedAt
                              ? new Date(dispatch.startedAt).toLocaleTimeString()
                              : '-'}
                          </td>
                          <td>
                            {dispatch.result ? (
                              <div className="missions-result-viewer">
                                <div>
                                  {dispatch.result.text?.slice(0, 120)}
                                  {dispatch.result.text && dispatch.result.text.length > 120 ? '…' : ''}
                                </div>
                                <div className="missions-result-meta">
                                  {dispatch.result.costUsd != null && (
                                    <span>Cost: ${dispatch.result.costUsd.toFixed(4)}</span>
                                  )}
                                  {dispatch.result.sessionId && (
                                    <span>Session: {dispatch.result.sessionId.slice(0, 8)}</span>
                                  )}
                                </div>
                              </div>
                            ) : isUnknownOrFailed ? (
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button
                                  className="missions-dispatch-btn"
                                  onClick={() => handleRetryDispatch(dispatch.id)}
                                  title="Retry dispatch"
                                >
                                  <RotateCw size={10} />
                                  <span>Retry</span>
                                </button>
                                <button
                                  className="missions-dispatch-btn"
                                  onClick={() => handleAbandonDispatch(dispatch.id)}
                                  title="Abandon dispatch"
                                >
                                  <XCircle size={10} />
                                  <span>Abandon</span>
                                </button>
                              </div>
                            ) : (
                              <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                                -
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </section>
            )}

            {activeState.gates && activeState.gates.length > 0 && (
              <section className="missions-section">
                <div className="missions-section-heading">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ShieldAlert size={13} />
                    <span>Decision Gates ({activeState.gates.length})</span>
                  </span>
                </div>
                <div className="missions-gates-list">
                  {activeState.gates.map((gate) => {
                    const task = activeState.tasks.find((t) => t.id === gate.taskId);
                    const isPending = gate.status === 'pending';
                    return (
                      <div key={gate.id} className="missions-gate-card">
                        <div className="missions-gate-header">
                          <span className={`mission-status-badge ${gate.status}`}>{gate.status}</span>
                          <span>Task: {task?.title || gate.taskId}</span>
                        </div>
                        <div className="missions-gate-question">{gate.question}</div>
                        {isPending ? (
                          <div className="missions-gate-actions">
                            {gate.options.map((opt) => (
                              <button
                                key={opt}
                                className={`missions-gate-btn ${opt.toLowerCase()}`}
                                onClick={() => handleResolveGate(gate.id, opt)}
                              >
                                {opt}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-success)' }}>
                            Decision: {gate.resolution}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {pendingAsks.length > 0 && (
              <section className="missions-section">
                <div className="missions-section-heading">
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <HelpCircle size={13} />
                    <span>Pending Clarifications ({pendingAsks.length})</span>
                  </span>
                </div>
                <div className="missions-asks-list">
                  {pendingAsks.map((ask) => {
                    const task = activeState.tasks.find((t) => `task_${t.id}` === ask.from);
                    return (
                      <div key={ask.id} className="missions-ask-card">
                        <div className="missions-ask-header">
                          <span>From: {task?.title || ask.from}</span>
                          <span>{new Date(ask.createdAt).toLocaleTimeString()}</span>
                        </div>
                        <div className="missions-ask-question">{ask.body}</div>
                        <div className="missions-reply-form">
                          <input
                            className="missions-reply-input"
                            placeholder="Type reply to worker..."
                            value={replyBuffers[ask.threadId] || ''}
                            onChange={(e) =>
                              setReplyBuffers((prev) => ({ ...prev, [ask.threadId]: e.target.value }))
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && (replyBuffers[ask.threadId] || '').trim()) {
                                void handleReplyAsk(ask.threadId);
                              }
                            }}
                          />
                          <button
                            className="missions-dispatch-btn"
                            disabled={!(replyBuffers[ask.threadId] || '').trim()}
                            onClick={() => void handleReplyAsk(ask.threadId)}
                          >
                            <Send size={10} />
                            <span>Reply</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <section className="missions-section">
              <div className="missions-section-heading">
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Mail size={13} />
                  <span>Mission Mailbox ({activeState.messages?.length || 0})</span>
                </span>
              </div>
              {activeState.messages && activeState.messages.length > 0 ? (
                <div className="missions-messages-list">
                  {activeState.messages.map((msg) => (
                    <div key={msg.id} className="missions-message-item">
                      <div className="missions-message-meta">
                        <span style={{ fontWeight: 600 }}>{msg.from}</span>
                        <span>→</span>
                        <span>{msg.to}</span>
                        <span style={{ color: 'var(--text-muted)' }}>({msg.kind})</span>
                        <span style={{ marginLeft: 'auto' }}>
                          {new Date(msg.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="missions-message-body">{msg.body}</div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="missions-empty-tasks">No messages in mission mailbox.</div>
              )}
              <div style={{ padding: '10px 14px', borderTop: '1px solid var(--border)' }}>
                <div className="missions-compose-box">
                  <input
                    className="missions-compose-input"
                    placeholder="Send message to worker or operator..."
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && composeBody.trim()) {
                        void handleSendMessage();
                      }
                    }}
                  />
                  <button
                    className="missions-dispatch-btn"
                    disabled={!composeBody.trim()}
                    onClick={() => void handleSendMessage()}
                  >
                    <Send size={10} />
                    <span>Send</span>
                  </button>
                </div>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
};
