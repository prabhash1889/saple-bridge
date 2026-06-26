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
  Terminal,
  Trash2,
  Users,
  XCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useProjectStore, ViewType } from '../../stores/projectStore';
import { useProviderStore } from '../../stores/providerStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useThemeStore, ThemeMode } from '../../stores/themeStore';
import bridgeMark from '../../assets/logo/saple-bridge-mark.png';

const workspaceEntries: Array<{
  id: ViewType;
  title: string;
  description: string;
  hint: string;
  icon: React.ElementType;
  alpha?: boolean;
}> = [
  {
    id: 'terminals',
    title: 'Saple Bridge',
    description: 'Open the command room and arrange local terminal agents.',
    hint: '1',
    icon: Terminal,
  },
  {
    id: 'swarm',
    title: 'Saple Swarm',
    description: 'Coordinate multi-agent missions for the current workspace.',
    hint: '2',
    icon: Users,
  },
  {
    id: 'editor',
    title: 'Saple Canvas',
    description: 'Inspect files and shape workspace context.',
    hint: '3',
    icon: Grid2X2,
  },
];

const getWorkspaceName = (path: string) => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
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
  } = useProjectStore();
  const openWorkspacePaths = openWorkspaces.map((w) => w.path);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const { panes, sessions, setFocusedPane } = useTerminalStore();
  const tasks = useKanbanStore((state) => state.tasks);
  const memories = useMemoryStore((state) => state.nodes);
  const activeAgents = useSwarmStore((state) => state.activeAgents);
  const providers = useProviderStore((state) => state.providers);
  const themeMode = useThemeStore((state) => state.mode);
  const setThemeMode = useThemeStore((state) => state.setMode);
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

  const reviewTasks = tasks.filter((task) => task.column === 'review');
  const activeTasks = tasks.filter((task) => task.column === 'backlog' || task.column === 'progress');
  const runningAgents = activeAgents.filter((agent) => ['running', 'waiting', 'review'].includes(agent.status));

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
          <strong>{memories.length}</strong>
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
          {memories.length === 0 ? (
            <div className="compact-empty">No memory notes found.</div>
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

      <div className="empty-dashboard-grid home-empty-grid">
        <section className="surface">
          <div className="panel-heading">
            <FolderOpen size={16} />
            <span>Recent Workspaces</span>
          </div>
          {recentProjects.length === 0 ? (
            <div className="compact-empty">No recent workspaces yet.</div>
          ) : (
            <div className="recent-project-table">
              {recentProjects.slice(0, 5).map((path) => {
                const name = getWorkspaceName(path);
                const health = recentHealth[path];
                return (
                  <button
                    key={path}
                    className="recent-project-item"
                    onClick={() => handleRecentClick(path)}
                    title={path}
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
        {legacyHomePanel}
      </div>

      <aside className="home-split-right" aria-label="Saple Bridge start">
        <div className="saple-start-center">
        <div className="saple-start-brand">
          <img src={bridgeMark} alt="" />
          <span>Saple Bridge</span>
        </div>

        <div className="saple-start-copy">
          <h1>PowerUp your work.</h1>
          <p>Choose how you want to work.</p>
        </div>

        <div className="saple-start-actions" role="list">
          {workspaceEntries.map((entry) => {
            const Icon = entry.icon;
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
                    {entry.alpha && <em>ALPHA</em>}
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
            value={themeMode === 'system' ? 'dark' : themeMode}
            onChange={(e) => setThemeMode(e.target.value as ThemeMode)}
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="ember">Ember</option>
            <option value="mocha">Mocha</option>
            <option value="nord">Nord</option>
            <option value="dracula">Dracula</option>
            <option value="tokyonight">Tokyo Night</option>
            <option value="solarized">Solarized Light</option>
            <option value="latte">Catppuccin Latte</option>
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
                return (
                  <button key={path} onClick={() => handleRecentClick(path)} title={path} disabled={workspaceLoading}>
                    <span className={`workspace-status ${health === false ? 'missing' : health === 'checking' ? 'pending' : 'idle'}`} />
                    <span>{getWorkspaceName(path)}</span>
                  </button>
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
