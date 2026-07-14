import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square, Shield, Edit, Bot, CheckCircle, Clock, Settings, Layers, LayoutGrid, Activity, AlertTriangle, Send, Terminal as TerminalIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useSwarmStore } from '../../stores/swarmStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { readRunOutcome } from '../../lib/controlPlane';
import type { AgentOutcome } from '../../types/agent';
import { isHeadlessProvider } from '../../types/provider';
import { SwarmGraph } from './SwarmGraph';
import { SwarmAgentCard, AgentHandoff } from './SwarmAgentCard';
import { SwarmTemplateEditor } from './SwarmTemplateEditor';
import { SwarmWizard } from './wizard/SwarmWizard';

const handoffKey = (from: string, to: string) => `${from}->${to}`;

// Strip ANSI escape sequences (CSI, OSC, single-char escapes) and bare carriage returns so raw
// PTY output reads as plain text in the inspect panel's tail view.
// eslint-disable-next-line no-control-regex -- matching terminal escape bytes is the point
const ANSI_RE = /(?:\u001b\[[0-9;?]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_])/g;
const stripAnsi = (raw: string) => raw.replace(ANSI_RE, '').replace(/\r/g, '');

const TAIL_CHARS = 4000;

// Live tail of an agent's terminal, fed from the same buffer/subscription xterm panes use.
// Lets the operator see what an agent is actually doing without leaving the Swarm room.
const AgentTerminalTail: React.FC<{ terminalId: string }> = ({ terminalId }) => {
  const [tail, setTail] = useState('');
  const scrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const { getBufferedOutput, subscribeOutput } = useTerminalStore.getState();
    let text = stripAnsi(getBufferedOutput(terminalId)).slice(-TAIL_CHARS);
    setTail(text);
    return subscribeOutput(terminalId, (event) => {
      text = (text + stripAnsi(event.data)).slice(-TAIL_CHARS);
      setTail(text);
    });
  }, [terminalId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tail]);

  return (
    <pre ref={scrollRef} style={terminalTailStyle}>
      {tail || 'No output yet.'}
    </pre>
  );
};

export const SwarmWorkspace: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const swarmId = useSwarmStore((state) => state.swarmId);
  const mission = useSwarmStore((state) => state.mission);
  const status = useSwarmStore((state) => state.status);
  const activeAgents = useSwarmStore((state) => state.activeAgents);
  const templates = useSwarmStore((state) => state.templates);
  const swarmActive = useSwarmStore((state) => state.swarmActive);
  const pendingWizardMission = useSwarmStore((state) => state.pendingWizardMission);
  const setPendingWizardMission = useSwarmStore((state) => state.setPendingWizardMission);
  const loadSwarmState = useSwarmStore((state) => state.loadSwarmState);
  const pauseSwarm = useSwarmStore((state) => state.pauseSwarm);
  const resumeSwarm = useSwarmStore((state) => state.resumeSwarm);
  const stopSwarm = useSwarmStore((state) => state.stopSwarm);
  const updateAgentStatus = useSwarmStore((state) => state.updateAgentStatus);
  const relaunchAgent = useSwarmStore((state) => state.relaunchAgent);
  const reworkAgent = useSwarmStore((state) => state.reworkAgent);
  const forceCompleteAgent = useSwarmStore((state) => state.forceCompleteAgent);
  const postToMailbox = useSwarmStore((state) => state.postToMailbox);
  const readHandoff = useSwarmStore((state) => state.readHandoff);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  // null until the user picks a template; the wizard then opens pre-seeded with it.
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [isEditingTemplate, setIsEditingTemplate] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'graph' | 'grid'>('graph');
  const [wizardOpen, setWizardOpen] = useState(false);
  // Mission text to pre-fill the wizard with, set by the Command Palette composer's "New swarm".
  const [wizardMission, setWizardMission] = useState<string | undefined>(undefined);
  const [mailboxContents, setMailboxContents] = useState<Record<string, string>>({});
  const [loadingMailboxIds, setLoadingMailboxIds] = useState<Set<string>>(() => new Set());
  // Handoff bodies keyed by `${from}->${to}`. Polled on the same timer as mailboxes.
  const [handoffContents, setHandoffContents] = useState<Record<string, string>>({});
  // Structured outcomes (P3) keyed by agent id, read from the canonical artifact store on the same
  // poll — so a completed agent's summary/test result shows on its card without opening the terminal.
  const [outcomes, setOutcomes] = useState<Record<string, AgentOutcome>>({});
  const [composeText, setComposeText] = useState('');
  const [sendingMailbox, setSendingMailbox] = useState(false);

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

  // Command Palette composer's "New swarm" target: open the wizard pre-filled with the composed
  // mission, then clear the one-shot flag so it doesn't reopen on the next render.
  useEffect(() => {
    if (pendingWizardMission != null) {
      setWizardMission(pendingWizardMission);
      setWizardOpen(true);
      setPendingWizardMission(null);
    }
  }, [pendingWizardMission, setPendingWizardMission]);

  // Drop any in-progress mailbox draft when the inspected agent changes so a message
  // typed for one agent isn't accidentally sent to another.
  useEffect(() => {
    setComposeText('');
  }, [selectedAgentId]);

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

  // Review gate (P4): reject routes the agent back through one bounded rework — feedback to its
  // mailbox, relaunch with that feedback. Past the attempt budget the store refuses and we require
  // an explicit human approval before forcing another attempt.
  const handleAgentReject = async (agentId: string, feedback: string) => {
    if (!currentProjectPath) return;
    const result = await reworkAgent(currentProjectPath, agentId, feedback);
    if (result.limitReached) {
      useConfirmStore.getState().confirm({
        title: 'Rework limit reached',
        message: `This agent has already used its ${result.maxAttempts ?? 1} allowed attempt(s). Approve another rework attempt?`,
        confirmLabel: 'Approve rework',
        onConfirm: () => {
          void reworkAgent(currentProjectPath, agentId, feedback, true);
        },
      });
    }
  };

  const handleAgentStop = async (agentId: string) => {
    if (!currentProjectPath) return;
    const agent = activeAgents.find(a => a.id === agentId);
    // Mark stopped BEFORE killing the pane: the kill fires pty-exit, and the exit fallback
    // must see a deliberate stop, not a running agent whose process died (-> failed).
    await updateAgentStatus(currentProjectPath, agentId, 'stopped', { statusReason: 'Stopped by operator.' });
    if (agent?.terminalId) {
      try {
        await useTerminalStore.getState().removePane(agent.terminalId);
      } catch (e) {
        console.error('Failed to remove pane:', e);
      }
    }
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

  // Handoff candidate pairs are the edges of the dependency graph: a dependency D "hands off"
  // to each agent A that depends on it (D->A). Agents are instructed to write
  // .saple/swarm/handoffs/<from>-to-<to>.json, so these are the only files that can exist.
  const handoffPairs = useMemo(() => {
    const pairs: { from: string; to: string }[] = [];
    const seen = new Set<string>();
    for (const agent of activeAgents) {
      for (const dep of agent.dependencies) {
        const key = handoffKey(dep, agent.id);
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ from: dep, to: agent.id });
      }
    }
    return pairs;
  }, [activeAgents]);

  // Only poll handoffs touching a currently-visible agent (mirrors the mailbox polled-set).
  const polledHandoffPairs = useMemo(() => {
    const visible = new Set(polledAgentIds);
    return handoffPairs.filter((p) => visible.has(p.from) || visible.has(p.to));
  }, [handoffPairs, polledAgentIds]);

  const polledHandoffKey = polledHandoffPairs.map((p) => handoffKey(p.from, p.to)).join('|');

  const fetchVisibleMailboxes = useCallback(async () => {
    if (!currentProjectPath || polledAgentIds.length === 0) return;

    setLoadingMailboxIds(new Set(polledAgentIds));
    const [entries, handoffEntries, outcomeEntries] = await Promise.all([
      Promise.all(
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
      ),
      Promise.all(
        polledHandoffPairs.map(async ({ from, to }) => {
          // readHandoff returns null for not-yet-written handoffs (the common case).
          const content = await readHandoff(currentProjectPath, from, to);
          return [handoffKey(from, to), content] as const;
        })
      ),
      Promise.all(
        polledAgentIds.map(async (agentId) => {
          // Resolve the agent's canonical run (agent → session by terminal → runId), then read its
          // recorded outcome. null when the agent has no run yet or hasn't recorded an outcome.
          const ag = useSwarmStore.getState().activeAgents.find((a) => a.id === agentId);
          const session = ag?.terminalId
            ? useAgentSessionStore.getState().getSessionByTerminalId(ag.terminalId)
            : undefined;
          if (!session?.runId) return [agentId, null] as const;
          const outcome = await readRunOutcome(currentProjectPath, session.runId);
          return [agentId, outcome] as const;
        })
      ),
    ]);

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
    setHandoffContents((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [key, content] of handoffEntries) {
        if (content === null) continue;
        if (next[key] !== content) {
          next[key] = content;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setOutcomes((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [agentId, outcome] of outcomeEntries) {
        if (outcome === null) continue;
        // Only re-render when the outcome actually changed (cheap deep compare via JSON).
        if (JSON.stringify(next[agentId]) !== JSON.stringify(outcome)) {
          next[agentId] = outcome;
          changed = true;
        }
      }
      return changed ? next : previous;
    });
    setLoadingMailboxIds(new Set());
  }, [currentProjectPath, polledAgentIds, polledHandoffPairs, readHandoff]);

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
    // Only re-run when the actual set of polled agents (polledAgentKey), the set of polled
    // handoff pairs (polledHandoffKey), or the project changes — not on every render that
    // leaves the polled sets identical.
  }, [currentProjectPath, polledAgentKey, polledHandoffKey]);

  // Resolved (content-present) handoffs grouped per agent, split by direction.
  const handoffsByAgent = useMemo(() => {
    const map: Record<string, AgentHandoff[]> = {};
    for (const { from, to } of handoffPairs) {
      const content = handoffContents[handoffKey(from, to)];
      if (!content) continue;
      (map[to] ??= []).push({ from, to, direction: 'in', content });
      (map[from] ??= []).push({ from, to, direction: 'out', content });
    }
    return map;
  }, [handoffPairs, handoffContents]);

  const handleSendMailbox = async () => {
    if (!currentProjectPath || !selectedAgentId || !composeText.trim()) return;
    setSendingMailbox(true);
    try {
      const next = await postToMailbox(currentProjectPath, selectedAgentId, composeText);
      setMailboxContents((prev) => ({ ...prev, [selectedAgentId]: next }));
      setComposeText('');
    } catch (err) {
      console.error('Failed to post mailbox message:', err);
    } finally {
      setSendingMailbox(false);
    }
  };

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
      <div className="swarm-scroll-pane">
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
            <div className="swarm-header-col">
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
            <h2 className="swarm-heading">
              Swarm Room Orchestrator
            </h2>
            {swarmActive && (
              <p className="swarm-subheading">
                Swarm ID: <code className="fg-accent">{swarmId}</code> | Mission: "{mission}"
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
                          onReject={handleAgentReject}
                          onStop={handleAgentStop}
                          mailboxContent={mailboxContents[agent.id]}
                          loadingMailbox={loadingMailboxIds.has(agent.id)}
                          handoffs={handoffsByAgent[agent.id]}
                          outcome={outcomes[agent.id]}
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
                      <Settings size={14} className="fg-muted" />
                      <span>Inspect Agent: {selectedAgent.name}</span>
                    </div>
                    <SwarmAgentCard
                      agent={selectedAgent}
                      projectPath={currentProjectPath}
                      onViewTerminal={handleViewTerminal}
                      onRelaunch={(id) => currentProjectPath && relaunchAgent(currentProjectPath, id)}
                      onForceComplete={(id) => currentProjectPath && forceCompleteAgent(currentProjectPath, id)}
                      onReject={handleAgentReject}
                      onStop={handleAgentStop}
                      mailboxContent={mailboxContents[selectedAgent.id]}
                      loadingMailbox={loadingMailboxIds.has(selectedAgent.id)}
                      handoffs={handoffsByAgent[selectedAgent.id]}
                      outcome={outcomes[selectedAgent.id]}
                    />

                    {/* Live tail of the agent's terminal so its actual work is visible
                        without leaving the room. "View Terminal" stays the full view. Headless
                        agents print nothing until they exit, so the label says so and points at
                        the mailbox above as the live surface (P10). */}
                    {selectedAgent.terminalId && (
                      <div style={composeBoxStyle}>
                        <div style={rightPanelTitleStyle}>
                          <TerminalIcon size={13} className="fg-muted" />
                          <span>
                            {isHeadlessProvider(selectedAgent.provider)
                              ? 'Terminal Output (headless - appears on completion)'
                              : 'Terminal Output (live)'}
                          </span>
                        </div>
                        <AgentTerminalTail terminalId={selectedAgent.terminalId} />
                      </div>
                    )}

                    {/* Operator → agent mailbox compose. Posts a message the agent can read
                        from its mailbox file mid-run. */}
                    <div style={composeBoxStyle}>
                      <div style={rightPanelTitleStyle}>
                        <Edit size={13} className="fg-muted" />
                        <span>Post to {selectedAgent.name}'s mailbox</span>
                      </div>
                      <textarea
                        value={composeText}
                        onChange={(e) => setComposeText(e.target.value)}
                        placeholder="Send guidance or context to this agent…"
                        rows={3}
                        style={composeTextareaStyle}
                        disabled={!currentProjectPath}
                      />
                      <button
                        onClick={handleSendMailbox}
                        className="primary"
                        style={composeSendBtnStyle}
                        disabled={!currentProjectPath || !composeText.trim() || sendingMailbox}
                      >
                        <Send size={12} />
                        <span>{sendingMailbox ? 'Sending…' : 'Send to mailbox'}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={emptyInspectStyle}>
                    <Shield size={32} className="fg-border" />
                    <p className="swarm-note">
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
            <Bot size={54} className="swarm-mb-16 swarm-hero-icon" />
            <h3 className="swarm-empty-title">Saple Swarm Coordinator</h3>
            <p className="swarm-empty-desc">
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
              <p className="swarm-empty-hint-lg">
                Open a workspace to create a swarm.
              </p>
            )}
          </div>
        )}
      </div>

      {wizardOpen && (
        <SwarmWizard
          projectPath={currentProjectPath}
          onClose={() => { setWizardOpen(false); setWizardMission(undefined); }}
          initialTemplateId={selectedTemplateId}
          initialMission={wizardMission}
        />
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

const terminalTailStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  maxHeight: '220px',
  overflowY: 'auto',
  fontSize: '11px',
  fontFamily: 'var(--font-mono, monospace)',
  color: 'var(--text-secondary)',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const composeBoxStyle: React.CSSProperties = {
  marginTop: '16px',
  paddingTop: '16px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const composeTextareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontFamily: 'inherit',
  outline: 'none',
};

const composeSendBtnStyle: React.CSSProperties = {
  alignSelf: 'flex-end',
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  height: '30px',
  padding: '0 12px',
  fontSize: '12px',
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
