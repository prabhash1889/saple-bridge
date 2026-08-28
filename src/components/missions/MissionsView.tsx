import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Flag,
  FolderOpen,
  ListChecks,
  Pause,
  Play,
  Plus,
  RotateCw,
  Save,
  Square,
  Trash2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../stores/projectStore';
import { useMissionStore } from '../../stores/missionStore';
import { useNotificationStore } from '../../stores/notificationStore';
import type { MissionState, MissionSummary, TaskKind, TaskSpecInput } from '../../types/mission';

// Missions room, minimal v1 (Phase M1): mission list + detail + mission.md editor +
// task table with a deps picker. No DAG rendering and no execution yet - dispatch
// arrives with M3; this room only plans.

interface TaskDraft {
  key: string;
  title: string;
  kind: TaskKind;
  spec: string;
  deps: string[];
}

const TASK_KINDS: TaskKind[] = ['implement', 'review', 'verify'];

const STATUS_ORDER: Record<MissionState['status'], Array<{ cmd: 'start' | 'pause' | 'resume' | 'cancel'; label: string; icon: React.ElementType }>> = {
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
  const loading = useMissionStore((state) => state.loading);
  const error = useMissionStore((state) => state.error);
  const loadMissions = useMissionStore((state) => state.loadMissions);
  const activeId = useMissionStore((state) => state.activeId);
  const activeState = useMissionStore((state) => state.activeState);
  const activeDoc = useMissionStore((state) => state.activeDoc);
  const activeWarnings = useMissionStore((state) => state.activeWarnings);
  const openMission = useMissionStore((state) => state.openMission);

  // Doc editor buffer. Kept local so typing never touches the engine until Save.
  const [docBuffer, setDocBuffer] = useState('');
  const [docDirty, setDocDirty] = useState(false);
  const [taskDrafts, setTaskDrafts] = useState<TaskDraft[]>([]);
  const [tasksDirty, setTasksDirty] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (currentProjectPath) void loadMissions(currentProjectPath);
  }, [currentProjectPath, loadMissions]);

  // Poll on focus until mission-event streaming lands in M3.
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

  // Reset local buffers on mission switch. Runs strictly on identity change so a
  // lifecycle command (which replaces activeState) cannot wipe unsaved edits.
  useEffect(() => {
    setDocBuffer(activeDoc ?? '');
    setDocDirty(false);
    setTaskDrafts(activeState ? draftsFromTasks(activeState.tasks) : []);
    setTasksDirty(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberate: sync only when the selected mission changes
  }, [activeId]);

  // Follow engine truth while the operator has no unsaved local edits (e.g. after an
  // external frontmatter edit was reconciled or another save landed).
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
    try {
      await useMissionStore.getState().saveDoc(currentProjectPath, activeId, docBuffer, activeState.revision);
      setDocDirty(false);
      useNotificationStore.getState().success('Mission document saved');
    } catch {
      // Error surfaced through the store banner (validation or revision conflict).
    }
  };

  const handleSaveTasks = async () => {
    if (!currentProjectPath || !activeId || !activeState) return;
    const specs: TaskSpecInput[] = taskDrafts.map((draft) => ({
      key: draft.key,
      title: draft.title.trim() || 'Untitled task',
      kind: draft.kind,
      spec: draft.spec,
      deps: draft.deps.filter((dep) => dep !== draft.key && taskDrafts.some((d) => d.key === dep)),
      fanout: 1,
    }));
    try {
      await useMissionStore.getState().saveTasks(currentProjectPath, activeId, activeState.revision, specs);
      setTasksDirty(false);
      useNotificationStore.getState().success('Task graph saved');
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

  const lifecycleActions = useMemo(
    () => (activeState ? STATUS_ORDER[activeState.status] ?? [] : []),
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
              <span className={`mission-status-badge ${activeState.status}`}>{activeState.status}</span>
              <span className="missions-revision">rev {activeState.revision}</span>
              {lifecycleActions.map(({ cmd, label, icon: Icon }) => (
                <button
                  key={cmd}
                  onClick={() => currentProjectPath && void useMissionStore.getState().runCommand(currentProjectPath, activeState.id, { type: cmd })}
                  title={label}
                >
                  <Icon size={13} />
                  <span>{label}</span>
                </button>
              ))}
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
                        { key: `t${Date.now().toString(36)}`, title: '', kind: 'implement', spec: '', deps: [] },
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
                      <th aria-label="Remove" />
                    </tr>
                  </thead>
                  <tbody>
                    {taskDrafts.map((draft, index) => (
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
                            onChange={(e) => updateDraft(index, { kind: e.target.value as TaskKind })}
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
                                  title={draft.deps.includes(other.key) ? 'Remove dependency' : 'Add dependency'}
                                >
                                  {other.title || 'untitled'}
                                </button>
                              ))}
                          </div>
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
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
};
