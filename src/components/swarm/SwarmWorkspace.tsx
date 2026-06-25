import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square, Shield, Edit, Bot, CheckCircle, Clock, Settings, Layers, LayoutGrid, Activity, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useSwarmStore } from '../../stores/swarmStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { SwarmGraph } from './SwarmGraph';
import { SwarmAgentCard } from './SwarmAgentCard';
import { SwarmTemplateEditor } from './SwarmTemplateEditor';
import { SwarmWizard } from './wizard/SwarmWizard';

export const SwarmWorkspace: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const swarmId = useSwarmStore((state) => state.swarmId);
  const mission = useSwarmStore((state) => state.mission);
  const status = useSwarmStore((state) => state.status);
  const activeAgents = useSwarmStore((state) => state.activeAgents);
  const templates = useSwarmStore((state) => state.templates);
  const swarmActive = useSwarmStore((state) => state.swarmActive);
  const loadSwarmState = useSwarmStore((state) => state.loadSwarmState);
  const pauseSwarm = useSwarmStore((state) => state.pauseSwarm);
  const resumeSwarm = useSwarmStore((state) => state.resumeSwarm);
  const stopSwarm = useSwarmStore((state) => state.stopSwarm);
  const updateAgentStatus = useSwarmStore((state) => state.updateAgentStatus);
  const relaunchAgent = useSwarmStore((state) => state.relaunchAgent);
  const forceCompleteAgent = useSwarmStore((state) => state.forceCompleteAgent);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  const [selectedTemplateId, setSelectedTemplateId] = useState('full_stack');
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'grid'>('graph');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [mailboxContents, setMailboxContents] = useState<Record<string, string>>({});
  const [loadingMailboxIds, setLoadingMailboxIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (currentProjectPath) {
      loadSwarmState(currentProjectPath);
    }
  }, [currentProjectPath, loadSwarmState]);

  // Set default selected agent once swarm starts
  useEffect(() => {
    if (swarmActive && activeAgents.length > 0 && !selectedAgentId) {
      setSelectedAgentId(activeAgents[0].id);
    }
  }, [swarmActive, activeAgents, selectedAgentId]);

  const handleStop = async () => {
    if (!currentProjectPath) return;
    await stopSwarm(currentProjectPath);
  };

  const handlePause = async () => {
    if (!currentProjectPath) return;
    await pauseSwarm(currentProjectPath);
  };

  const handleResume = async () => {
    if (!currentProjectPath) return;
    await resumeSwarm(currentProjectPath);
  };

  const handleViewTerminal = (paneId: string) => {
    setFocusedPane(paneId);
    useProjectStore.getState().setActiveView('terminals');
  };

  const handleAgentStop = async (agentId: string) => {
    if (!currentProjectPath) return;
    const agent = activeAgents.find(a => a.id === agentId);
    if (agent?.terminalId) {
      try {
        await useTerminalStore.getState().removePane(agent.terminalId);
      } catch (e) {
        console.error('Failed to remove pane:', e);
      }
    }
    await updateAgentStatus(currentProjectPath, agentId, 'stopped');
  };

  const polledAgentIds = useMemo(() => {
    const ids = viewMode === 'grid'
      ? activeAgents.map((agent) => agent.id)
      : selectedAgentId
        ? [selectedAgentId]
        : [];
    return Array.from(new Set(ids)).slice(0, 8);
  }, [activeAgents, selectedAgentId, viewMode]);

  const polledAgentKey = polledAgentIds.join('|');

  const fetchVisibleMailboxes = useCallback(async () => {
    if (!currentProjectPath || polledAgentIds.length === 0) return;

    setLoadingMailboxIds(new Set(polledAgentIds));
    const entries = await Promise.all(
      polledAgentIds.map(async (agentId) => {
        try {
          const content = await invoke<string>('read_mailbox_file', {
            projectPath: currentProjectPath,
            agentId,
          });
          return [agentId, content] as const;
        } catch (err) {
          console.error(`Failed to read mailbox for agent ${agentId}:`, err);
          return [agentId, null] as const;
        }
      })
    );

    setMailboxContents((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [agentId, content] of entries) {
        if (content === null) continue;
        if (next[agentId] !== content) {
          next[agentId] = content;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setLoadingMailboxIds(new Set());
  }, [currentProjectPath, polledAgentIds]);

  // Keep the latest fetch callback in a ref so the polling interval below can call it
  // without listing it as a dependency. fetchVisibleMailboxes changes identity whenever
  // polledAgentIds changes, and polledAgentIds is recomputed on every activeAgents update
  // (frequent during a swarm run). Depending on it would tear down and recreate the
  // interval constantly, each time firing an extra immediate fetch burst.
  const fetchVisibleMailboxesRef = useRef(fetchVisibleMailboxes);
  useEffect(() => {
    fetchVisibleMailboxesRef.current = fetchVisibleMailboxes;
  }, [fetchVisibleMailboxes]);

  useEffect(() => {
    void fetchVisibleMailboxesRef.current();
    if (!currentProjectPath || polledAgentKey.length === 0) return;

    const interval = window.setInterval(() => {
      void fetchVisibleMailboxesRef.current();
    }, 5000);

    return () => window.clearInterval(interval);
    // Only re-run when the actual set of polled agents (polledAgentKey) or the project
    // changes — not on every render that leaves the polled set identical.
  }, [currentProjectPath, polledAgentKey]);

  const getSwarmStatusBadge = (swarmStatus: typeof status) => {
    switch (swarmStatus) {
      case 'running':
        return <span style={statusPillStyle('running')}><Activity size={12} className="spin" /> RUNNING</span>;
      case 'paused':
        return <span style={statusPillStyle('paused')}><Pause size={12} /> PAUSED</span>;
      case 'completed':
        return <span style={statusPillStyle('completed')}><CheckCircle size={12} /> COMPLETED</span>;
      case 'failed':
        return <span style={statusPillStyle('failed')}><AlertTriangle size={12} /> FAILED</span>;
      case 'stopped':
        return <span style={statusPillStyle('stopped')}><Square size={12} /> STOPPED</span>;
      default:
        return <span style={statusPillStyle('idle')}><Clock size={12} /> IDLE</span>;
    }
  };

  const selectedTemplate = templates.find(t => t.id === selectedTemplateId) || templates[0];
  const selectedAgent = activeAgents.find(a => a.id === selectedAgentId);

  if (isEditingTemplate) {
    return (
      <div style={{ padding: '24px', overflowY: 'auto', height: '100%', backgroundColor: 'var(--bg-app)' }}>
        <SwarmTemplateEditor
          template={selectedTemplate}
          onSave={() => setIsEditingTemplate(false)}
          onCancel={() => setIsEditingTemplate(false)}
        />
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {/* Sidebar - Templates & General Settings */}
      <div style={sidebarStyle}>
        <div style={sectionGroupStyle}>
          <h3 style={sectionTitleStyle}>Swarm Templates</h3>
          <p style={subTextStyle}>Select the orchestration pattern to deploy.</p>
          
          <div style={templateListStyle}>
            {templates.map(t => {
              const selected = selectedTemplateId === t.id;
              const cardClass = [
                'swarm-template-card',
                selected ? 'is-selected' : '',
                swarmActive ? 'is-disabled' : '',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={t.id}
                  onClick={() => !swarmActive && setSelectedTemplateId(t.id)}
                  className={cardClass}
                >
                  <div className="swarm-template-title">{t.name}</div>
                  <div className="swarm-template-desc">{t.description}</div>
                </div>
              );
            })}
          </div>

          {!swarmActive && (
            <button
              onClick={() => setIsEditingTemplate(true)}
              className="swarm-ghost-btn"
            >
              <Edit size={11} />
              <span>Modify Template Preset</span>
            </button>
          )}
        </div>

        {/* Global Controls */}
        <div style={actionsContainerStyle}>
          {swarmActive ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {status === 'running' ? (
                <button onClick={handlePause} className="secondary" style={btnStyle}>
                  <Pause size={12} />
                  <span>Pause Pipeline</span>
                </button>
              ) : (
                <button onClick={handleResume} className="primary" style={btnStyle}>
                  <Play size={12} />
                  <span>Resume Pipeline</span>
                </button>
              )}
              <button onClick={handleStop} className="danger" style={btnStyle}>
                <Square size={12} />
                <span>Terminate Swarm</span>
              </button>
            </div>
          ) : (
            <button
              onClick={() => setWizardOpen(true)}
              className="primary swarm-cta"
              style={btnStartStyle}
              disabled={!currentProjectPath}
            >
              <Play size={12} />
              <span>Create Swarm</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Panel */}
      <div style={mainContentStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)', margin: 0 }}>
              Swarm Room Orchestrator
            </h2>
            {swarmActive && (
              <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Swarm ID: <code style={{ color: 'var(--accent)' }}>{swarmId}</code> | Mission: "{mission}"
              </p>
            )}
          </div>
          <div>
            {getSwarmStatusBadge(status)}
          </div>
        </div>

        {swarmActive ? (
          <div style={swarmDashboardStyle}>
            {/* View Tabs */}
            <div style={tabsBarStyle}>
              <div style={tabsGroupStyle}>
                <button
                  onClick={() => setViewMode('graph')}
                  className={`swarm-tab${viewMode === 'graph' ? ' is-active' : ''}`}
                >
                  <Layers size={13} />
                  <span>Dependency Graph</span>
                </button>
                <button
                  onClick={() => setViewMode('grid')}
                  className={`swarm-tab${viewMode === 'grid' ? ' is-active' : ''}`}
                >
                  <LayoutGrid size={13} />
                  <span>Agent Cards Grid</span>
                </button>
              </div>
            </div>

            {/* Split Screen Workspace */}
            <div style={workspaceGridStyle}>
              {/* Left View (Graph or Grid) */}
              <div style={leftPanelStyle}>
                {viewMode === 'graph' ? (
                  <SwarmGraph
                    agents={activeAgents}
                    onSelectAgent={setSelectedAgentId}
                    selectedAgentId={selectedAgentId || undefined}
                    onRelaunch={(agentId) => currentProjectPath && relaunchAgent(currentProjectPath, agentId)}
                  />
                ) : (
                  <div style={cardsGridStyle}>
                    {activeAgents.map(agent => (
                      <div
                        key={agent.id}
                        onClick={() => setSelectedAgentId(agent.id)}
                        className={`swarm-grid-card${selectedAgentId === agent.id ? ' is-selected' : ''}`}
                      >
                        <SwarmAgentCard
                          agent={agent}
                          projectPath={currentProjectPath}
                          onViewTerminal={handleViewTerminal}
                          onRelaunch={(id) => currentProjectPath && relaunchAgent(currentProjectPath, id)}
                          onForceComplete={(id) => currentProjectPath && forceCompleteAgent(currentProjectPath, id)}
                          onStop={handleAgentStop}
                          mailboxContent={mailboxContents[agent.id]}
                          loadingMailbox={loadingMailboxIds.has(agent.id)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Right Panel: Selected Agent Inspect Panel */}
              <div style={rightPanelStyle}>
                {selectedAgent ? (
                  <div>
                    <div style={rightPanelTitleStyle}>
                      <Settings size={14} style={{ color: 'var(--text-muted)' }} />
                      <span>Inspect Agent: {selectedAgent.name}</span>
                    </div>
                    <SwarmAgentCard
                      agent={selectedAgent}
                      projectPath={currentProjectPath}
                      onViewTerminal={handleViewTerminal}
                      onRelaunch={(id) => currentProjectPath && relaunchAgent(currentProjectPath, id)}
                      onForceComplete={(id) => currentProjectPath && forceCompleteAgent(currentProjectPath, id)}
                      onStop={handleAgentStop}
                      mailboxContent={mailboxContents[selectedAgent.id]}
                      loadingMailbox={loadingMailboxIds.has(selectedAgent.id)}
                    />
                  </div>
                ) : (
                  <div style={emptyInspectStyle}>
                    <Shield size={32} style={{ color: 'var(--border)' }} />
                    <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '8px' }}>
                      Select any agent node to inspect logs and handoffs.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          /* Empty / Idle State */
          <div style={emptyStateStyle}>
            <Bot size={54} className="swarm-hero-icon" style={{ marginBottom: '16px' }} />
            <h3 style={{ fontSize: '18px', fontWeight: 600, color: 'var(--text-primary)' }}>Saple Swarm Coordinator</h3>
            <p style={{ maxWidth: '520px', color: 'var(--text-muted)', fontSize: '13px', marginTop: '8px', lineHeight: '1.6', textAlign: 'center' }}>
              Coordinators analyze missions, breaking down requirements onto a shared workspace filesystem, while Builders and Reviewers run validation test cycles inside parallel terminal streams.
            </p>

            <button
              onClick={() => setWizardOpen(true)}
              className="primary swarm-cta"
              style={btnLaunchMissionStyle}
              disabled={!currentProjectPath}
            >
              <Play size={13} />
              <span>Create Swarm</span>
            </button>
            {!currentProjectPath && (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '12px' }}>
                Open a workspace to create a swarm.
              </p>
            )}
          </div>
        )}
      </div>

      {wizardOpen && (
        <SwarmWizard projectPath={currentProjectPath} onClose={() => setWizardOpen(false)} />
      )}
    </div>
  );
};

/* --- Inline CSS Styles --- */

const containerStyle: React.CSSProperties = {
  display: 'flex',
  height: '100%',
  width: '100%',
  overflow: 'hidden',
  backgroundColor: 'var(--bg-app)',
};

const sidebarStyle: React.CSSProperties = {
  width: '280px',
  borderRight: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface)',
  display: 'flex',
  flexDirection: 'column',
  padding: '20px',
  overflowY: 'auto',
  gap: '24px',
};

const sectionGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  flex: 1,
};

const mainContentStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  overflowY: 'auto',
  backgroundColor: 'var(--bg-app)',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  margin: 0,
};

const subTextStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted)',
  lineHeight: '1.4',
  margin: 0,
};

const templateListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const actionsContainerStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  paddingTop: '16px',
};

const btnStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: '36px',
  fontSize: '13px',
};

const btnStartStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: '36px',
  fontSize: '13px',
};

const headerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  backgroundColor: 'var(--bg-surface-light)',
};

const statusPillStyle = (swarmStatus: string): React.CSSProperties => {
  let bg = 'rgba(107, 114, 128, 0.15)';
  let color = 'var(--text-muted)';
  let border = '1px solid var(--border)';

  if (swarmStatus === 'running') {
    bg = 'rgba(99, 102, 241, 0.15)';
    color = 'var(--accent)';
    border = '1px solid rgba(99, 102, 241, 0.3)';
  } else if (swarmStatus === 'paused') {
    bg = 'rgba(245, 158, 11, 0.15)';
    color = 'var(--color-warning)';
    border = '1px solid rgba(245, 158, 11, 0.3)';
  } else if (swarmStatus === 'completed') {
    bg = 'rgba(34, 197, 94, 0.15)';
    color = 'var(--color-success)';
    border = '1px solid rgba(34, 197, 94, 0.3)';
  } else if (swarmStatus === 'failed') {
    bg = 'rgba(239, 68, 68, 0.15)';
    color = 'var(--color-danger)';
    border = '1px solid rgba(239, 68, 68, 0.3)';
  }

  return {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '11px',
    fontWeight: 700,
    padding: '4px 10px',
    borderRadius: '12px',
    backgroundColor: bg,
    color,
    border,
  };
};

const swarmDashboardStyle: React.CSSProperties = {
  padding: '16px 24px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  flex: 1,
  overflowY: 'auto',
};

const tabsBarStyle: React.CSSProperties = {
  display: 'flex',
  borderBottom: '1px solid var(--border)',
  paddingBottom: '10px',
};

const tabsGroupStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
};

const workspaceGridStyle: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
  flex: 1,
  minHeight: 0,
};

const leftPanelStyle: React.CSSProperties = {
  flex: 3,
  overflowY: 'auto',
};

const rightPanelStyle: React.CSSProperties = {
  flex: 2,
  borderLeft: '1px solid var(--border)',
  paddingLeft: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflowY: 'auto',
};

const rightPanelTitleStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  marginBottom: '8px',
};

const emptyInspectStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '240px',
  border: '1px dashed var(--border)',
  borderRadius: 'var(--radius-md)',
  textAlign: 'center',
  padding: '24px',
};

const cardsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: '16px',
};

const emptyStateStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '60px 40px',
};

const btnLaunchMissionStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: '38px',
  fontSize: '13px',
  marginTop: '24px',
};
