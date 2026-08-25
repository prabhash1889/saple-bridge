import React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  ChevronDown,
  ClipboardList,
  Database,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Grid2X2,
  History,
  Layers3,
  Network,
  PanelTop,
  RotateCw,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  X,
  XCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useBrowserStore } from '../../stores/browserStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useProjectStore, ViewType } from '../../stores/projectStore';
import { useProviderStore } from '../../stores/providerStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useThemeStore, ThemeMode, THEME_OPTIONS } from '../../stores/themeStore';
import bridgeMark from '../../assets/logo/saple-bridge-mark.png';
import { workspaceEntries } from './workspaceEntries';

const getWorkspaceName = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
};

// Icons for the shared workspaceEntries list (kept here so the entries module stays
// dependency-free and its shortcut hints stay unit-testable).
const ENTRY_ICONS: Record<string, React.ElementType> = {
  terminals: Terminal,
  swarm: Users,
  editor: Grid2X2,
};

// Compact provider readiness status, shared by the empty-home card and the onboarding step.
const ProviderChecklist: React.FC = () => {
  const providers = useProviderStore((state) => state.providers);
  return (
    <div className="provider-checklist">
      {providers.filter((p) => p.provider !== 'custom').map((p) => {
        const signed = p.signedIn === true;
        const ready = p.authenticated === true || signed;
        const pending = p.authenticated === null && !signed;
        return (
          <span key={p.provider}>
            <span className={`status-dot ${ready ? 'ready' : pending ? 'pending' : 'missing'}`} />
            {p.label}
            {p.authenticated === true && ' - key saved'}
            {p.authenticated !== true && signed && ' - signed in'}
            {!ready && !pending && ' - auth needed'}
            {pending && ' - checking...'}
          </span>
        );
      })}
    </div>
  );
};

// Compact relative timestamp ("just now", "5m ago", "3h ago", "2d ago") for the
// workspace history list. Falls back to weeks for anything older than a week.
const formatRelativeTime = (ts: number): string => {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
};

// Home is a light view that remounts on every visit. Without this module-level cache,
// resolved health results would be lost on unmount and `checkPathExists` (which spawns a
// git subprocess per recent project) would re-run for every path on each visit.
const recentHealthCache: Record<string, boolean> = {};

export const ProjectDashboard: React.FC = () => {
  const {
    currentProjectPath,
    currentProjectName,
    recentProjects,
    workspaceHistory,
    clearWorkspaceHistory,
    openWorkspace,
    addWorkspace,
    setActiveView,
    workspaceSummary,
    workspaceLoading,
    checkPathExists,
    openWorkspaces,
    removeRecentProject,
    stalePaths,
    dismissStalePath,
    relocateWorkspace,
    workspaceError,
    currentWorkspaceId,
    openWorkspaceInstance,
    clearWorkspaceError,
    onboardingOpen,
    onboardingDismissed,
    dismissOnboarding,
  } = useProjectStore();
  const openWorkspacePaths = openWorkspaces.map((w) => w.path);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const { panes, sessions, setFocusedPane } = useTerminalStore();
  const tasks = useKanbanStore((state) => state.tasks);
  const memories = useMemoryStore((state) => state.nodes);
  // The home page must not show a premature zero for memory counts: gate them on the
  // graph actually having been loaded (and kept fresh) for this project.
  const memoryLoaded = useMemoryStore((state) => !!currentProjectPath && state.loadedProjectPath === currentProjectPath);
  const memoryLoading = useMemoryStore((state) => state.loading);
  const activeAgents = useSwarmStore((state) => state.activeAgents);
  const themeMode = useThemeStore((state) => state.mode);
  const setThemeMode = useThemeStore((state) => state.setMode);
  const confirm = useConfirmStore((state) => state.confirm);
  const [recentHealth, setRecentHealth] = React.useState<Record<string, boolean | 'checking'>>(() => ({ ...recentHealthCache }));

  React.useEffect(() => {
    const paths = Array.from(new Set([...recentProjects, ...workspaceHistory.map((e) => e.path)]));
    paths.forEach(async (path) => {
      if (recentHealth[path] !== undefined) return;
      setRecentHealth((prev) => ({ ...prev, [path]: 'checking' }));
      const exists = await checkPathExists(path);
      recentHealthCache[path] = exists;
      setRecentHealth((prev) => ({ ...prev, [path]: exists }));
    });
  }, [recentProjects, workspaceHistory, checkPathExists, recentHealth]);

  const handleOpenWorkspace = async (targetView: ViewType = 'terminals') => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        // Always add a new instance, so the same folder can be opened multiple
        // times (numbered in the sidebar), matching the sidebar "+" button.
        await addWorkspace(selectedPath);
        setActiveView(targetView);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleEntryClick = async (view: ViewType) => {
    if (currentProjectPath) {
      setActiveView(view);
      return;
    }
    await handleOpenWorkspace(view);
  };

  const handleRecentClick = async (path: string) => {
    await openWorkspace(path);
    setActiveView('terminals');
  };

  // Per-entry recents removal: drop the path from the persisted recent lists and clear
  // its cached health result so a re-added path is checked fresh.
  const handleRemoveRecent = (path: string) => {
    delete recentHealthCache[path];
    setRecentHealth((prev) => {
      if (prev[path] === undefined) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    removeRecentProject(path);
  };

  // Recovery for a stale persisted path (validated at cold start): point the workspace at
  // its new location, or drop it from workspaces + recents entirely.
  const handleRelocateStale = async (fromPath: string) => {
    try {
      const newPath = await invoke<string | null>('select_directory');
      if (!newPath) return;
      await relocateWorkspace(fromPath, newPath);
      useNotificationStore.getState().success(
        'Workspace relocated',
        `${getWorkspaceName(fromPath)} now points at ${newPath}.`,
      );
    } catch (error) {
      console.error('Failed to relocate workspace:', error);
      useNotificationStore.getState().error(`Failed to relocate workspace: ${String(error)}`);
    }
  };

  const handleForgetStale = (path: string) => {
    confirm({
      title: 'Remove missing workspace?',
      message: `"${getWorkspaceName(path)}" could not be found on disk. This removes it from your open workspaces and recents. Your files are not touched.`,
      confirmLabel: 'Remove',
      onConfirm: () => {
        const store = useProjectStore.getState();
        // Close every open instance of that path first so its PTYs and browser session
        // don't outlive it (same teardown the sidebar close uses).
        for (const instance of store.openWorkspaces.filter((w) => w.path === path)) {
          void useTerminalStore.getState().closeWorkspaceTerminals(instance.id);
          void useBrowserStore.getState().closeWorkspaceBrowser(instance.id);
          store.closeWorkspace(instance.id);
          void invoke('release_project_root', { path }).catch(() => {});
        }
        handleRemoveRecent(path);
        dismissStalePath(path);
      },
    });
  };

  const reviewTasks = tasks.filter((task) => task.column === 'review');
  const activeTasks = tasks.filter((task) => task.column === 'backlog' || task.column === 'progress');
  const runningAgents = activeAgents.filter((agent) => ['running', 'waiting', 'review'].includes(agent.status));
  // First run: no workspace has ever been opened and the user hasn't dismissed the
  // walkthrough. It can also be re-opened on demand (Help / command palette).
  const walkthroughVisible = (!currentProjectPath && !onboardingDismissed && workspaceHistory.length === 0) || onboardingOpen;

  React.useEffect(() => {
    if (walkthroughVisible) void useProviderStore.getState().refreshReadiness();
  }, [walkthroughVisible]);

  // Recovery for a failed workspace load (config/summary registration failed): retry the
  // same open flow, or jump to diagnostics to find out why.
  const handleWorkspaceRetry = () => {
    clearWorkspaceError();
    if (currentWorkspaceId) {
      void openWorkspaceInstance(currentWorkspaceId);
    } else if (currentProjectPath) {
      void useProjectStore.getState().refreshWorkspace();
    }
  };

  const handleRunDiagnostics = () => {
    useProjectStore.getState().setPendingSettingsTab('diagnostics');
    setActiveView('settings');
  };

  const handleOpenProviderSetup = () => {
    useProjectStore.getState().setPendingSettingsTab('providers');
    setActiveView('settings');
  };

  // Getting-started walkthrough: automatic on true first run, and re-openable any time
  // (command palette / Help). Includes live provider readiness so new users see whether
  // an agent can actually run before they commit to a workspace.
  const walkthroughPanel = walkthroughVisible ? (
    <section className="surface onboarding-panel" aria-label="Getting started walkthrough">
      <div className="panel-heading">
        <Layers3 size={16} />
        <span>Start Here</span>
        <button
          type="button"
          className="text-btn"
          onClick={dismissOnboarding}
          title="Hide the walkthrough"
          aria-label="Hide the walkthrough"
          style={{ marginLeft: 'auto', padding: 2, display: 'flex', lineHeight: 0 }}
        >
          <X size={14} />
        </button>
      </div>
      <div className="onboarding-steps">
        <article className="onboarding-step">
          <span className="onboarding-step-icon"><FolderOpen size={16} /></span>
          <strong>Open a repo folder</strong>
          <p>Bridge creates the local `.saple` workspace files inside your project.</p>
        </article>
        <article className="onboarding-step">
          <span className="onboarding-step-icon"><Terminal size={16} /></span>
          <strong>Launch a terminal</strong>
          <p>Use the Command Room for shells, coding agents, and live logs.</p>
        </article>
        <article className="onboarding-step">
          <span className="onboarding-step-icon"><ClipboardList size={16} /></span>
          <strong>Create a task</strong>
          <p>Move tasks through backlog, progress, review, and done.</p>
        </article>
        <article className="onboarding-step">
          <span className="onboarding-step-icon"><ShieldCheck size={16} /></span>
          <strong>Connect a provider</strong>
          <p>Agents need at least one provider with a saved key or CLI sign-in.</p>
          <ProviderChecklist />
          <button type="button" className="text-btn" onClick={handleOpenProviderSetup}>
            Set up providers in Settings
          </button>
        </article>
      </div>
      {!currentProjectPath && (
        <button onClick={() => handleOpenWorkspace('terminals')} className="primary onboarding-primary-action">
          <FolderOpen size={16} />
          Open first workspace
        </button>
      )}
    </section>
  ) : null;

  const legacyHomePanel = currentProjectPath ? (
    <section className="dashboard-shell home-legacy-panel">
      <div className="workspace-summary-band">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2>{currentProjectName}</h2>
          <p title={currentProjectPath}>{currentProjectPath}</p>
          {workspaceSummary && (
            <div className="summary-flags">
              {workspaceSummary.isGitRepo ? (
                <span className="summary-flag ok"><CheckCircle size={12} /> git: {workspaceSummary.branch}</span>
              ) : (
                <span className="summary-flag warn"><AlertTriangle size={12} /> not a git repo</span>
              )}
              {workspaceSummary.hasSapleConfig ? (
                <span className="summary-flag ok"><CheckCircle size={12} /> configured</span>
              ) : (
                <span className="summary-flag warn"><AlertTriangle size={12} /> no config</span>
              )}
              {workspaceSummary.hasMcpConfig ? (
                <span className="summary-flag ok"><CheckCircle size={12} /> MCP ready</span>
              ) : (
                <span className="summary-flag warn"><AlertTriangle size={12} /> no MCP</span>
              )}
            </div>
          )}
        </div>
      </div>

      {workspaceLoading && <div className="loading-bar">Loading workspace...</div>}

      {workspaceError && (
        <div role="alert" className="state-recovery-banner">
          <div className="state-recovery-header">
            <AlertTriangle className="h-5 w-5" aria-hidden style={{ color: 'var(--color-danger)' }} />
            <div>
              <p className="font-semibold">Workspace failed to load</p>
              <p className="state-recovery-error">{workspaceError}</p>
              <p className="state-recovery-hint">Retry the load, or run diagnostics to check what is wrong.</p>
            </div>
          </div>
          <div className="state-recovery-actions">
            <button type="button" disabled={workspaceLoading} onClick={handleWorkspaceRetry}>
              <RotateCw aria-hidden /> Retry
            </button>
            <button type="button" onClick={handleRunDiagnostics}>
              Run diagnostics
            </button>
            <button type="button" onClick={clearWorkspaceError}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="metric-grid home-metric-grid">
        <button className="metric-card accent-command" onClick={() => setActiveView('terminals')}>
          <PanelTop size={18} />
          <span>Running Terminals</span>
          <strong>{panes.length} / {useProjectStore.getState().workspaceConfig?.maxParallelAgents ?? 16}</strong>
        </button>
        <button className="metric-card accent-swarm" onClick={() => setActiveView('swarm')}>
          <Users size={18} />
          <span>Active Agents</span>
          <strong>{runningAgents.length}</strong>
        </button>
        <button className="metric-card accent-tasks" onClick={() => setActiveView('kanban')}>
          <ClipboardList size={18} />
          <span>Open Tasks</span>
          <strong>{activeTasks.length}</strong>
        </button>
        <button className="metric-card accent-review" onClick={() => setActiveView('review')}>
          <GitPullRequest size={18} />
          <span>Review Queue</span>
          <strong>{reviewTasks.length}</strong>
        </button>
        <button className="metric-card accent-memory" onClick={() => setActiveView('memory')}>
          <Database size={18} />
          <span>Memory Notes</span>
          <strong>{!memoryLoaded ? (memoryLoading ? '...' : '-') : memories.length}</strong>
        </button>
      </div>

      <div className="dashboard-main-grid home-dashboard-grid">
        <section className="surface">
          <div className="panel-heading">
            <ClipboardList size={16} />
            <span>Today Queue</span>
          </div>
          {activeTasks.length === 0 ? (
            <div className="compact-empty">No backlog or in-progress tasks.</div>
          ) : (
            activeTasks.slice(0, 6).map((task) => (
              <article key={task.id} className="dashboard-list-item">
                <strong>{task.title}</strong>
                <span>{task.column} - {task.agentConfig?.provider ?? 'unassigned'}</span>
              </article>
            ))
          )}
        </section>

        <section className="surface">
          <div className="panel-heading">
            <Terminal size={16} />
            <span>Active Sessions</span>
          </div>
          {panes.length === 0 ? (
            <div className="compact-empty">No terminal sessions are running.</div>
          ) : (
            panes.slice(0, 8).map((paneId) => (
              <article 
                key={paneId} 
                className="dashboard-list-item clickable"
                onClick={() => {
                  setFocusedPane(paneId);
                  setActiveView('terminals');
                }}
                role="button"
                tabIndex={0}
              >
                <strong>{sessions[paneId]?.name ?? paneId}</strong>
                <span>{sessions[paneId]?.aiProvider ?? 'shell'} - {sessions[paneId]?.cwd ?? currentProjectName}</span>
              </article>
            ))
          )}
        </section>

        <section className="surface">
          <div className="panel-heading">
            <GitPullRequest size={16} />
            <span>Review Queue</span>
          </div>
          {reviewTasks.length === 0 ? (
            <div className="compact-empty">No tasks are waiting for review.</div>
          ) : (
            reviewTasks.slice(0, 5).map((task) => (
              <article key={task.id} className="dashboard-list-item">
                <strong>{task.title}</strong>
                <span>{task.terminalId ? `Pane ${task.terminalId}` : 'No linked terminal'}</span>
              </article>
            ))
          )}
        </section>

        <section className="surface">
          <div className="panel-heading">
            <Network size={16} />
            <span>Recent Memories</span>
          </div>
          {memoryLoaded && memories.length === 0 ? (
            <div className="compact-empty">No memory notes found.</div>
          ) : !memoryLoaded ? (
            <div className="compact-empty">{memoryLoading ? 'Loading memory...' : 'Memory has not been loaded for this workspace yet.'}</div>
          ) : (
            memories.slice(0, 5).map((memory) => (
              <article key={memory.id} className="dashboard-list-item">
                <strong>{memory.title}</strong>
                <span>{memory.category} - {memory.tags.slice(0, 3).join(', ') || 'untagged'}</span>
              </article>
            ))
          )}
        </section>
      </div>

      {walkthroughPanel && (
        <div style={{ marginTop: 12 }}>{walkthroughPanel}</div>
      )}
    </section>
  ) : (
    <section className="dashboard-shell no-workspace home-legacy-panel">
      <div className="room-header">
        <div>
          <p className="eyebrow">Local-first agent workroom</p>
          <h2>Open a workspace</h2>
          <p>Start from a repo folder, then use rooms for commands, tasks, memory, swarms, and reviews.</p>
        </div>
        <button onClick={() => handleOpenWorkspace('dashboard')} className="primary">
          <FolderOpen size={17} />
          Open Workspace
        </button>
      </div>

      {walkthroughPanel && (
        <div style={{ marginBottom: 12 }}>{walkthroughPanel}</div>
      )}

      <div className="empty-dashboard-grid home-empty-grid">
        <section className="surface">
          <div className="panel-heading">
            <FolderOpen size={16} />
            <span>Recent Workspaces</span>
          </div>
          {recentProjects.length === 0 ? (
            <div className="compact-empty empty-state-card">
              <FolderOpen size={18} />
              <span>No recent workspaces yet.</span>
            </div>
          ) : (
            <div className="recent-project-table">
              {recentProjects.slice(0, 5).map((path) => {
                const name = getWorkspaceName(path);
                const health = recentHealth[path];
                return (
                  <div key={path} className="recent-project-item">
                    <button
                      type="button"
                      className="text-btn recent-project-open"
                      onClick={() => handleRecentClick(path)}
                      title={path}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, padding: 0, textAlign: 'left' }}
                    >
                      {health === false ? (
                        <XCircle size={14} className="icon-missing" />
                      ) : health === 'checking' ? (
                        <span className="status-dot pending" />
                      ) : (
                        <FolderOpen size={14} />
                      )}
                      <span className={health === false ? 'text-muted' : ''}>{name}</span>
                      {health === false && <span className="badge warning-badge">missing</span>}
                    </button>
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => handleRemoveRecent(path)}
                      title={`Remove ${name} from recents`}
                      aria-label={`Remove ${name} from recents`}
                      style={{ flexShrink: 0, padding: 3, display: 'flex', lineHeight: 0 }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="surface">
          <div className="panel-heading">
            <Terminal size={16} />
            <span>Provider Readiness</span>
          </div>
          <ProviderChecklist />
        </section>

        <section className="surface">
          <div className="panel-heading">
            <ClipboardList size={16} />
            <span>Workspace Layout</span>
          </div>
          <div className="path-list">
            <code>.saple/config.json</code>
            <code>.saple/tasks.json</code>
            <code>.saple/agents/</code>
            <code>.saple/memory/</code>
            <code>.saple/review/</code>
          </div>
        </section>
      </div>
    </section>
  );

  return (
    <section className="home-split" aria-label="Saple Bridge home">
      <div className="home-split-left">
        {stalePaths.length > 0 && (
          <div role="alert" className="state-recovery-banner" style={{ marginBottom: 12 }}>
            <div className="state-recovery-header">
              <AlertTriangle className="h-5 w-5" aria-hidden style={{ color: 'var(--color-warning)' }} />
              <div>
                <p className="font-semibold">Workspace folder not found</p>
                {stalePaths.map((path) => (
                  <p key={path} className="state-recovery-path"><code>{path}</code></p>
                ))}
                <p className="state-recovery-hint">
                  These folders were moved or deleted. Relocate a workspace to its new
                  location, or remove it from the list.
                </p>
              </div>
            </div>
            <div className="state-recovery-actions">
              {stalePaths.map((path) => (
                <React.Fragment key={path}>
                  <button type="button" disabled={workspaceLoading} onClick={() => void handleRelocateStale(path)}>
                    <FolderOpen aria-hidden /> Relocate {getWorkspaceName(path)}
                  </button>
                  <button type="button" onClick={() => handleForgetStale(path)}>
                    <X aria-hidden /> Remove
                  </button>
                  <button type="button" onClick={() => dismissStalePath(path)}>
                    Dismiss
                  </button>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
        {legacyHomePanel}
      </div>

      <aside className="home-split-right" aria-label="Saple Bridge start">
        <div className="saple-start-center">
        <div className="saple-start-brand">
          <img src={bridgeMark} alt="" />
          <span>Saple Bridge</span>
        </div>

        <div className="saple-start-copy">
          <h1>Every Terminal One Workspace</h1>
          <p>Choose how you want to work.</p>
        </div>

        <div className="saple-start-actions" role="list">
          {workspaceEntries.map((entry) => {
            const Icon = ENTRY_ICONS[entry.id] ?? FolderOpen;
            return (
              <button
                key={entry.id}
                className="saple-start-entry"
                onClick={() => handleEntryClick(entry.id)}
                title={entry.title}
              >
                <span className="saple-start-entry-icon">
                  <Icon size={18} />
                </span>
                <span className="saple-start-entry-copy">
                  <span>
                    {entry.title}
                  </span>
                  <small>{entry.description}</small>
                </span>
                <kbd>{entry.hint}</kbd>
                <ArrowRight size={17} className="saple-start-entry-arrow" />
              </button>
            );
          })}
        </div>

        <div className="saple-start-theme">
          <label className="input-label" htmlFor="theme-select">Color scheme</label>
          <select
            id="theme-select"
            className="settings-select"
            value={themeMode}
            onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>

        <div className="saple-start-workspace">
          <div className="saple-start-workspace-heading">
            <span>Workspace</span>
            <button onClick={() => handleOpenWorkspace('terminals')} disabled={workspaceLoading}>
              <FolderOpen size={14} />
              Add Workspace
            </button>
          </div>

          {currentProjectPath ? (
            <button
              className="saple-start-current"
              onClick={() => setActiveView('terminals')}
              title={currentProjectPath}
            >
              <Layers3 size={15} />
              <span>
                <strong>{currentProjectName}</strong>
                <small>
                  {workspaceSummary?.branch && <GitBranch size={11} />}
                  {workspaceSummary?.branch ? `${workspaceSummary.branch} - ` : ''}
                  {currentProjectPath}
                </small>
              </span>
            </button>
          ) : (
            <p className="saple-start-empty">Open a repo folder to launch Saple Bridge.</p>
          )}

          {recentProjects.length > 0 && (
            <div className="saple-start-recent">
              {recentProjects
                .filter(p => !openWorkspacePaths.includes(p) && p !== currentProjectPath)
                .slice(0, 4)
                .map((path) => {
                const health = recentHealth[path];
                const name = getWorkspaceName(path);
                return (
                  <div key={path} style={{ position: 'relative', minWidth: 0 }}>
                    <button
                      onClick={() => handleRecentClick(path)}
                      title={path}
                      disabled={workspaceLoading}
                      style={{ width: '100%', paddingRight: 20 }}
                    >
                      <span className={`workspace-status ${health === false ? 'missing' : health === 'checking' ? 'pending' : 'idle'}`} />
                      <span>{name}</span>
                    </button>
                    <button
                      type="button"
                      className="text-btn"
                      onClick={() => handleRemoveRecent(path)}
                      title={`Remove ${name} from recents`}
                      aria-label={`Remove ${name} from recents`}
                      style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', padding: 3, display: 'flex', lineHeight: 0 }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {workspaceHistory.length > 0 && (
          <div className="saple-start-history">
            <button
              type="button"
              className="saple-start-history-toggle"
              onClick={() => setHistoryOpen((open) => !open)}
              aria-expanded={historyOpen}
            >
              <History size={14} />
              <span>History</span>
              <em>{workspaceHistory.length}</em>
              <ChevronDown
                size={15}
                className={`saple-start-history-chevron${historyOpen ? ' open' : ''}`}
              />
            </button>

            {historyOpen && (
              <div className="saple-start-history-list">
                {workspaceHistory.map((entry) => {
                  const health = recentHealth[entry.path];
                  return (
                    <button
                      key={entry.path}
                      className="saple-start-history-item"
                      onClick={() => handleRecentClick(entry.path)}
                      title={entry.path}
                      disabled={workspaceLoading}
                    >
                      <span className={`workspace-status ${health === false ? 'missing' : health === 'checking' ? 'pending' : 'idle'}`} />
                      <span className="saple-start-history-name">{entry.name}</span>
                      <span className="saple-start-history-time">{formatRelativeTime(entry.openedAt)}</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="saple-start-history-clear"
                  onClick={() => {
                    clearWorkspaceHistory();
                    setHistoryOpen(false);
                  }}
                >
                  <Trash2 size={12} />
                  Clear history
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      </aside>
    </section>
  );
};
