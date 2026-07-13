import React, { memo } from 'react';
import { Terminal, Play, Square, CheckCircle, RefreshCw, FileText, ArrowRightLeft, XCircle, Info } from 'lucide-react';
import { SwarmAgent, AgentStatus } from '../../stores/swarmStore';
import { isHeadlessProvider } from '../../types/provider';
import type { AgentOutcome } from '../../types/agent';
import { MarkdownPreview } from '../editor/MarkdownPreview';

// A resolved handoff file involving this agent. `direction` is relative to the agent the
// card renders: `in` = another agent handed off to this one, `out` = this one handed off.
export interface AgentHandoff {
  from: string;
  to: string;
  direction: 'in' | 'out';
  content: string;
}

interface SwarmAgentCardProps {
  agent: SwarmAgent;
  projectPath: string | null;
  onViewTerminal: (terminalId: string) => void;
  onRelaunch: (agentId: string) => void;
  onForceComplete: (agentId: string) => void;
  onReject: (agentId: string) => void;
  onStop: (agentId: string) => void;
  mailboxContent?: string;
  loadingMailbox?: boolean;
  handoffs?: AgentHandoff[];
  // Structured completion outcome (P3), read from the canonical artifact store — lets the reviewer
  // see what the agent did without opening its terminal.
  outcome?: AgentOutcome;
}

// Handoff files are JSON; wrap in a fenced block so the markdown viewer renders them as a
// code block rather than mangling the braces into a paragraph.
const asMarkdown = (content: string) => {
  const trimmed = content.trim();
  return '```json\n' + trimmed + '\n```';
};

const SwarmAgentCardComponent: React.FC<SwarmAgentCardProps> = ({
  agent,
  onViewTerminal,
  onRelaunch,
  onForceComplete,
  onReject,
  onStop,
  mailboxContent = '',
  loadingMailbox = false,
  handoffs = [],
  outcome,
}) => {
  const hasOutcome = !!outcome && (!!outcome.summary || !!outcome.tests || !!outcome.changedFiles?.length || !!outcome.decisions?.length);
  // Headless agents pipe their prompt into the CLI's print mode: the terminal stays silent until
  // the process exits, so the mailbox is the live surface. Flag it while the agent is working so
  // an empty terminal reads as "headless", not "hung" (P10).
  const headless = isHeadlessProvider(agent.provider);
  const headlessWorking = headless && (agent.status === 'running' || agent.status === 'starting');
  const getStatusIcon = (status: AgentStatus) => {
    switch (status) {
      case 'running':
        return <RefreshCw size={14} className="fg-accent spin" />;
      case 'done':
        return <CheckCircle size={14} className="fg-success" />;
      case 'failed':
        return <Square size={14} className="fg-danger" />;
      case 'review':
        return <FileText size={14} className="fg-warning" />;
      default:
        return <Square size={14} className="fg-muted" />;
    }
  };

  const getRoleColor = (role: string) => {
    switch (role) {
      case 'coordinator': return 'var(--accent)';
      case 'builder': return 'var(--color-success)';
      case 'reviewer': return 'var(--color-info)';
      case 'scout': return 'var(--color-warning)';
      default: return 'var(--text-secondary)';
    }
  };

  return (
    <div style={cardStyle(agent.status)}>
      {/* Top Header */}
      <div style={cardHeaderStyle}>
        <div>
          <h4 className="swarm-card-title">
            {agent.name}
          </h4>
          <span style={roleBadgeStyle(getRoleColor(agent.role))}>{agent.role}</span>
        </div>
        <div style={statusBadgeStyle(agent.status)}>
          {getStatusIcon(agent.status)}
          <span className="swarm-status-label">{agent.status}</span>
        </div>
      </div>

      {/* Why the agent is in its current state (exit fallback, recovery, operator action). */}
      {agent.statusReason && (
        <div style={statusReasonStyle}>
          <Info size={12} className="fg-muted" />
          <span>{agent.statusReason}</span>
        </div>
      )}

      {/* Headless liveness hint (P10): a piped-prompt agent prints nothing until it exits, so tell
          the operator the terminal silence is expected and the mailbox below is the live view. */}
      {headlessWorking && (
        <div style={headlessHintStyle}>
          <RefreshCw size={12} className="fg-accent spin" />
          <span>Headless run - terminal output appears on completion. Watch the mailbox below for live progress.</span>
        </div>
      )}

      {/* Structured outcome (P3): summary + test result the agent recorded, so the reviewer never
          has to open the terminal to know what happened. */}
      {hasOutcome && (
        <div style={outcomeSectionStyle}>
          <div style={outcomeHeaderStyle}>
            <FileText size={12} className="fg-accent" />
            <span style={sectionTitleStyle}>Outcome</span>
          </div>
          {outcome?.summary && <p style={outcomeSummaryStyle}>{outcome.summary}</p>}
          {outcome?.tests && (outcome.tests.command || outcome.tests.passed !== undefined) && (
            <div style={outcomeTestRowStyle}>
              {outcome.tests.passed === true && <CheckCircle size={12} className="fg-success" />}
              {outcome.tests.passed === false && <XCircle size={12} className="fg-danger" />}
              <span style={outcomeTestTextStyle}>
                {outcome.tests.command || 'tests'}
                {outcome.tests.passed === undefined ? '' : outcome.tests.passed ? ' · passed' : ' · failed'}
              </span>
            </div>
          )}
          {(outcome?.changedFiles?.length || outcome?.decisions?.length) && (
            <div style={outcomeMetaRowStyle}>
              {outcome?.changedFiles?.length ? <span>{outcome.changedFiles.length} file(s) changed</span> : null}
              {outcome?.decisions?.length ? <span>{outcome.decisions.length} decision(s)</span> : null}
            </div>
          )}
        </div>
      )}

      {/* Details / System Prompt */}
      <div style={bodyStyle}>
        <div style={detailRowStyle}>
          <span style={labelStyle}>Provider / Model</span>
          <span style={valueStyle}>{agent.provider || 'codex'} / {agent.model}</span>
        </div>
        <div style={detailRowStyle}>
          <span style={labelStyle}>Dependencies</span>
          <span style={valueStyle}>{agent.dependencies.join(', ') || 'None'}</span>
        </div>
        
        <div style={promptSectionStyle}>
          <div style={sectionTitleStyle}>System Instructions</div>
          <p style={promptTextStyle}>{agent.systemPrompt}</p>
        </div>

        {/* Mailbox Section */}
        <div style={mailboxSectionStyle}>
          <div style={mailboxHeaderStyle}>
            <div style={sectionTitleStyle}>Mailbox Output</div>
            {loadingMailbox && <span style={loadingLabelStyle}>syncing...</span>}
          </div>
          <div style={mailboxViewerStyle}>
            {mailboxContent ? (
              <pre style={mailboxPreStyle}>{mailboxContent}</pre>
            ) : (
              <span className="swarm-meta-text">No messages written yet.</span>
            )}
          </div>
        </div>

        {/* Handoffs Section — JSON files this agent sent/received from its dependency edges. */}
        {handoffs.length > 0 && (
          <div style={mailboxSectionStyle}>
            <div style={mailboxHeaderStyle}>
              <div style={sectionTitleStyle}>Handoffs</div>
            </div>
            <div style={handoffListStyle}>
              {handoffs.map((h) => (
                <div key={`${h.from}->${h.to}`} style={handoffItemStyle}>
                  <div style={handoffLabelStyle}>
                    <ArrowRightLeft size={11} className="fg-accent" />
                    <span>
                      {h.direction === 'in' ? `${h.from} → this` : `this → ${h.to}`}
                    </span>
                  </div>
                  <div style={handoffViewerStyle}>
                    <MarkdownPreview content={asMarkdown(h.content)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer Controls */}
      <div style={cardFooterStyle}>
        <div style={actionsGroupStyle}>
          {agent.terminalId && (
            <button 
              onClick={() => onViewTerminal(agent.terminalId!)} 
              style={btnViewStreamStyle}
            >
              <Terminal size={12} />
              <span>View Terminal</span>
            </button>
          )}

          {agent.status === 'running' && (
            <button 
              onClick={() => onStop(agent.id)} 
              className="danger"
              style={btnControlStyle}
            >
              <Square size={12} />
              <span>Stop</span>
            </button>
          )}

          {(agent.status === 'failed' || agent.status === 'stopped' || agent.status === 'blocked') && (
            <button
              onClick={() => onRelaunch(agent.id)}
              className="primary"
              style={btnControlStyle}
            >
              <Play size={12} />
              <span>Relaunch</span>
            </button>
          )}

          {/* Review gate: dependents wait until a human approves or rejects. */}
          {agent.status === 'review' && (
            <>
              <button
                onClick={() => onForceComplete(agent.id)}
                style={btnCompleteStyle}
              >
                <CheckCircle size={12} />
                <span>Approve</span>
              </button>
              <button
                onClick={() => onReject(agent.id)}
                className="danger"
                style={btnControlStyle}
              >
                <XCircle size={12} />
                <span>Reject</span>
              </button>
            </>
          )}

          {/* Stall escape hatch for a live agent; review/failed/stopped have their own controls. */}
          {(agent.status === 'running' || agent.status === 'starting') && (
            <button
              onClick={() => onForceComplete(agent.id)}
              style={btnCompleteStyle}
            >
              <CheckCircle size={12} />
              <span>Mark Done</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const SwarmAgentCard = memo(SwarmAgentCardComponent);

/* --- Styles --- */

const cardStyle = (status: AgentStatus): React.CSSProperties => {
  let glow = 'none';
  if (status === 'running') {
    glow = '0 0 12px rgba(99, 102, 241, 0.15)';
  }
  return {
    backgroundColor: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-lg)',
    padding: '18px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    boxShadow: glow,
    transition: 'box-shadow 0.2s',
  };
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
};

const statusReasonStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '6px',
  fontSize: '11px',
  lineHeight: '1.4',
  color: 'var(--text-secondary)',
  backgroundColor: 'var(--bg-surface-light)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '6px 8px',
};

const headlessHintStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '6px',
  fontSize: '11px',
  lineHeight: '1.4',
  color: 'var(--text-secondary)',
  backgroundColor: 'rgba(99, 102, 241, 0.08)',
  border: '1px solid rgba(99, 102, 241, 0.2)',
  borderRadius: 'var(--radius-sm)',
  padding: '6px 8px',
};

const outcomeSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '8px 10px',
  backgroundColor: 'var(--bg-surface-light)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
};

const outcomeHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const outcomeSummaryStyle: React.CSSProperties = {
  fontSize: '11.5px',
  lineHeight: '1.45',
  color: 'var(--text-secondary)',
  margin: 0,
};

const outcomeTestRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '11px',
};

const outcomeTestTextStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  color: 'var(--text-secondary)',
};

const outcomeMetaRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  fontSize: '10.5px',
  color: 'var(--text-muted)',
};

const roleBadgeStyle = (color: string): React.CSSProperties => ({
  fontSize: '9.5px',
  fontWeight: 700,
  textTransform: 'uppercase',
  padding: '2px 6px',
  borderRadius: 'var(--radius-sm)',
  color,
  backgroundColor: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid transparent',
  display: 'inline-block',
  marginTop: '4px',
});

const statusBadgeStyle = (status: AgentStatus): React.CSSProperties => {
  let color = 'var(--text-muted)';
  if (status === 'running') color = 'var(--accent)';
  if (status === 'done') color = 'var(--color-success)';
  if (status === 'review') color = 'var(--color-warning)';
  if (status === 'failed') color = 'var(--color-danger)';

  return {
    color,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  };
};

const bodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  flex: 1,
};

const detailRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  fontSize: '11px',
  borderBottom: '1px solid rgba(255, 255, 255, 0.02)',
  paddingBottom: '6px',
};

const labelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
};

const valueStyle: React.CSSProperties = {
  color: 'var(--text-secondary)',
  fontWeight: 500,
};

const promptSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '10px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
};

const promptTextStyle: React.CSSProperties = {
  fontSize: '11.5px',
  color: 'var(--text-secondary)',
  lineHeight: '1.45',
  backgroundColor: 'var(--bg-surface-light)',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
  maxHeight: '80px',
  overflowY: 'auto',
  margin: 0,
};

const mailboxSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  marginTop: '4px',
};

const mailboxHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const loadingLabelStyle: React.CSSProperties = {
  fontSize: '9px',
  color: 'var(--text-muted)',
  fontStyle: 'italic',
};

const mailboxViewerStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  maxHeight: '150px',
  overflowY: 'auto',
};

const mailboxPreStyle: React.CSSProperties = {
  fontSize: '11px',
  fontFamily: 'monospace',
  color: 'var(--text-secondary)',
  margin: 0,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const handoffListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const handoffItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

const handoffLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '10.5px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
};

const handoffViewerStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px 10px',
  maxHeight: '160px',
  overflowY: 'auto',
  fontSize: '11px',
};

const cardFooterStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border)',
  paddingTop: '12px',
  marginTop: '4px',
};

const actionsGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '8px',
};

const btnViewStreamStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '11px',
  height: '28px',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  backgroundColor: 'rgba(99, 102, 241, 0.1)',
  color: 'var(--accent)',
  border: '1px solid rgba(99, 102, 241, 0.2)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const btnControlStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '11px',
  height: '28px',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const btnCompleteStyle: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: '11px',
  height: '28px',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  backgroundColor: 'rgba(34, 197, 94, 0.1)',
  color: 'var(--color-success)',
  border: '1px solid rgba(34, 197, 94, 0.2)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};
