import React, { useRef } from 'react';
import { X, Play, Terminal, CheckCircle2, Shield, FileText, CheckSquare, Edit, AlertCircle } from 'lucide-react';
import { Task, useKanbanStore } from '../../stores/kanbanStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProjectStore } from '../../stores/projectStore';
import { useProviderStore } from '../../stores/providerStore';
import { formatShortDateTime } from '../../lib/date';
import { createId } from '../../lib/id';
import { invoke } from '@tauri-apps/api/core';
import { useNotificationStore } from '../../stores/notificationStore';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface TaskDetailDrawerProps {
  task: Task | null;
  isOpen: boolean;
  onClose: () => void;
  onEdit: (task: Task) => void;
}

export const TaskDetailDrawer: React.FC<TaskDetailDrawerProps> = ({ task, isOpen, onClose, onEdit }) => {
  const { currentProjectPath } = useProjectStore();
  const { updateTask } = useKanbanStore();
  const { sessions: agentSessions } = useAgentSessionStore();
  const { sessions: terminalSessions, addPane, setFocusedPane } = useTerminalStore();
  const drawerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(drawerRef, isOpen && Boolean(task), onClose);

  if (!isOpen || !task) return null;

  // Find linked agent session
  const agentSession = task.sessionId
    ? agentSessions.find(s => s.id === task.sessionId)
    : undefined;

  // Check if terminal is currently open and running
  const isTerminalRunning = task.terminalId && terminalSessions[task.terminalId];

  // Helper for role pill styling
  const getRoleStyle = (role?: string) => {
    let color = 'var(--text-secondary)';
    let bg = 'var(--bg-surface-active)';
    if (role === 'builder') {
      color = 'var(--color-success)';
      bg = 'var(--color-success-bg)';
    } else if (role === 'coordinator') {
      color = 'var(--accent)';
      bg = 'var(--accent-light)';
    } else if (role === 'reviewer') {
      color = 'var(--color-info)';
      bg = 'var(--color-info-bg)';
    } else if (role === 'scout') {
      color = 'var(--color-warning)';
      bg = 'var(--color-warning-bg)';
    }
    return { color, backgroundColor: bg };
  };

  // Helper for priority pill styling
  const getPriorityStyle = (priority: Task['priority']) => {
    let color = 'var(--text-secondary)';
    let bg = 'var(--bg-surface-active)';
    if (priority === 'urgent') {
      color = 'var(--color-danger)';
      bg = 'var(--color-danger-bg)';
    } else if (priority === 'high') {
      color = 'var(--color-warning)';
      bg = 'var(--color-warning-bg)';
    } else if (priority === 'normal') {
      color = 'var(--color-success)';
      bg = 'var(--color-success-bg)';
    }
    return { color, backgroundColor: bg };
  };

  // Both buttons route through the same flow ReviewWorkspace uses: submit_review_decision
  // atomically records the decision in .saple/review/<taskId>.json and updates the task +
  // session, then we re-read tasks so the board reflects the moved card.
  const handleApprove = async () => {
    if (!currentProjectPath) return;
    try {
      await useReviewStore.getState().submitReviewDecision(currentProjectPath, task.id, 'approve');
      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      onClose();
    } catch (err) {
      console.error('Approve failed:', err);
      useNotificationStore.getState().error(`Approve failed: ${String(err)}`);
    }
  };

  const handleReject = async () => {
    if (!currentProjectPath) return;
    try {
      await useReviewStore.getState().submitReviewDecision(currentProjectPath, task.id, 'reject');
      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      onClose();
    } catch (err) {
      console.error('Reject failed:', err);
      useNotificationStore.getState().error(`Reject failed: ${String(err)}`);
    }
  };

  const handleViewTerminal = () => {
    if (task.terminalId && isTerminalRunning) {
      setFocusedPane(task.terminalId);
      useProjectStore.getState().setActiveView('terminals');
      onClose();
    }
  };

  const handleLaunchAgent = async () => {
    if (!currentProjectPath) return;

    const provider = task.agentConfig?.provider || 'codex';
    const isProviderReady = useProviderStore.getState().isReady(provider);

    if (!isProviderReady) {
      useNotificationStore.getState().error(`Provider "${provider}" is not configured. Please open Settings to configure.`);
      return;
    }

    try {
      const sessionId = task.sessionId || createId('agent');
      const promptPath = `.saple/agents/prompts/${sessionId}.md`;

      const systemPrompt = task.agentConfig?.systemPrompt || 'You are an autonomous coding builder.';
      const model = task.agentConfig?.model || 'default';
      const role = task.agentConfig?.role || 'builder';
      const acceptance = task.acceptanceCriteria || [];
      const targets = task.targetFiles || [];

      const promptContent = `# Task: ${task.title}
## Description
${task.description || 'No description provided.'}

## Acceptance Criteria
${acceptance.length > 0 ? acceptance.map(a => `- ${a}`).join('\n') : '* None specified.'}

## Target Files
${targets.length > 0 ? targets.map(t => `- ${t}`).join('\n') : '* None specified.'}

## Agent Role Instructions
Role: ${role}
Instructions: ${systemPrompt}
`;

      await invoke('write_project_file', {
        projectPath: currentProjectPath,
        filePath: promptPath,
        content: promptContent,
      });

      const paneId = await addPane(currentProjectPath, provider, model, promptPath);

      const session = await useAgentSessionStore.getState().createSession({
        id: sessionId,
        projectPath: currentProjectPath,
        name: `${role.toUpperCase()} - ${task.title}`,
        cwd: currentProjectPath,
        provider,
        model,
        role,
        taskId: task.id,
        terminalId: paneId,
      });

      await updateTask(currentProjectPath, task.id, {
        terminalId: paneId,
        sessionId: session.id,
        column: 'progress'
      });

      useTerminalStore.getState().updateSession(paneId, {
        name: `${provider.toUpperCase()} Agent: ${task.title}`,
        agentSessionId: session.id
      });

      onClose();
      useProjectStore.getState().setActiveView('terminals');
    } catch (error) {
      console.error('Launch agent failed:', error);
      useNotificationStore.getState().error(`Launch failed: ${String(error)}`);
    }
  };

  return (
    <div style={drawerOverlayStyle} onClick={onClose}>
      <div
        ref={drawerRef}
        style={drawerContainerStyle}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-detail-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div className="task-drawer-title-group">
            <span style={statusStyle(task.column)}>{task.column.toUpperCase()}</span>
            <h3 id="task-detail-title" style={titleStyle}>{task.title}</h3>
          </div>
          <div className="task-drawer-header-actions">
            <button
              onClick={() => { onEdit(task); onClose(); }}
              style={iconBtnStyle}
              title="Edit Task"
              aria-label={`Edit ${task.title}`}
            >
              <Edit size={16} />
            </button>
            <button
              onClick={onClose}
              style={iconBtnStyle}
              title="Close Panel"
              aria-label="Close task details"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {/* Left / Main Details */}
          <div style={leftSectionStyle}>
            {/* Description */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}><FileText size={14} /> Description</h4>
              <p style={descTextStyle}>{task.description || 'No description provided.'}</p>
            </div>

            {/* Acceptance Criteria */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}><CheckSquare size={14} /> Acceptance Criteria</h4>
              {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 ? (
                <div className="task-drawer-criteria-list">
                  {task.acceptanceCriteria.map((c, i) => (
                    <div key={i} style={criteriaRowStyle}>
                      <input type="checkbox" readOnly checked={task.column === 'done'} style={checkboxStyle} />
                      <span className="task-drawer-criteria-text">{c}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p style={mutedTextStyle}>No acceptance criteria defined.</p>
              )}
            </div>

            {/* Target Files */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}><FileText size={14} /> Target Files</h4>
              {task.targetFiles && task.targetFiles.length > 0 ? (
                <div className="task-drawer-file-chips">
                  {task.targetFiles.map((file, i) => (
                    <span key={i} style={fileChipStyle}>
                      {file}
                    </span>
                  ))}
                </div>
              ) : (
                <p style={mutedTextStyle}>No specific files targeted.</p>
              )}
            </div>
          </div>

          {/* Right / Metadata Sidebar */}
          <div style={rightSectionStyle}>
            {/* General Metadata */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}>Task Meta</h4>
              <div style={metaGridStyle}>
                <span style={metaLabelStyle}>Priority</span>
                <span style={{ ...metaValStyle, ...getPriorityStyle(task.priority) }}>
                  {task.priority.toUpperCase()}
                </span>

                <span style={metaLabelStyle}>Created</span>
                <span style={metaValTextStyle}>{formatShortDateTime(task.createdAt)}</span>

                <span style={metaLabelStyle}>Updated</span>
                <span style={metaValTextStyle}>{formatShortDateTime(task.updatedAt)}</span>
              </div>
            </div>

            {/* Labels */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}>Labels</h4>
              <div className="task-drawer-label-list">
                {task.labels && task.labels.length > 0 ? (
                  task.labels.map(l => (
                    <span key={l} style={labelBadgeStyle}>{l}</span>
                  ))
                ) : (
                  <span style={mutedTextStyle}>No labels</span>
                )}
              </div>
            </div>

            {/* Agent Configurations */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}><Shield size={14} /> Agent Settings</h4>
              {task.agentConfig ? (
                <div style={metaGridStyle}>
                  <span style={metaLabelStyle}>Role</span>
                  <span style={{ ...metaValStyle, ...getRoleStyle(task.agentConfig.role) }}>
                    {task.agentConfig.role.toUpperCase()}
                  </span>

                  <span style={metaLabelStyle}>Provider</span>
                  <span style={metaValTextStyle}>{task.agentConfig.provider}</span>

                  <span style={metaLabelStyle}>Model</span>
                  <span style={metaValTextStyle}>{task.agentConfig.model}</span>
                </div>
              ) : (
                <p style={mutedTextStyle}>No agent configured.</p>
              )}
            </div>

            {/* Linked Session Info */}
            <div style={cardSectionStyle}>
              <h4 style={sectionTitleStyle}><Terminal size={14} /> Agent Session</h4>
              {agentSession ? (
                <div style={metaGridStyle}>
                  <span style={metaLabelStyle}>Status</span>
                  <span style={sessionStatusStyle(agentSession.status)}>
                    {agentSession.status.toUpperCase()}
                  </span>

                  <span style={metaLabelStyle}>Logs</span>
                  <span style={metaValTextStyle} title={agentSession.outputLogPath}>
                    ...{agentSession.outputLogPath.split('/').pop()}
                  </span>

                  {agentSession.completedAt && (
                    <>
                      <span style={metaLabelStyle}>Finished</span>
                      <span style={metaValTextStyle}>{formatShortDateTime(agentSession.completedAt)}</span>
                    </>
                  )}
                </div>
              ) : (
                <p style={mutedTextStyle}>No active or prior session linked.</p>
              )}
            </div>
          </div>
        </div>

        {/* Drawer Actions / Footer */}
        <div style={footerStyle}>
          {task.column === 'review' && (
            <div className="task-drawer-review-actions">
              <button
                onClick={handleReject}
                className="secondary-action"
                style={{ ...btnStyle, borderColor: 'var(--color-danger)', color: 'var(--color-danger)', flex: 1 }}
              >
                <AlertCircle size={14} /> Reject Changes
              </button>
              <button
                onClick={handleApprove}
                className="primary"
                style={{ ...btnStyle, backgroundColor: 'var(--color-success)', borderColor: 'var(--color-success)', color: 'white', flex: 1 }}
              >
                <CheckCircle2 size={14} /> Approve & Merge
              </button>
            </div>
          )}

          {task.column !== 'review' && (
            <div className="task-drawer-footer-actions">
              {isTerminalRunning ? (
                <button
                  onClick={handleViewTerminal}
                  className="primary"
                  style={{ ...btnStyle, flex: 1 }}
                >
                  <Terminal size={14} /> View Terminal
                </button>
              ) : (
                <button
                  onClick={handleLaunchAgent}
                  className="primary"
                  style={{ ...btnStyle, flex: 1 }}
                  disabled={!currentProjectPath}
                >
                  <Play size={14} /> Launch Agent
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* --- Drawer Styles --- */

const drawerOverlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.4)',
  zIndex: 100,
  display: 'flex',
  justifyContent: 'flex-end',
};

const drawerContainerStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '680px',
  height: '100%',
  backgroundColor: 'var(--bg-app)',
  borderLeft: '1px solid var(--border)',
  boxShadow: 'var(--shadow-lg)',
  display: 'flex',
  flexDirection: 'column',
  animation: 'slideIn 0.2s ease-out',
};

const headerStyle: React.CSSProperties = {
  padding: '20px 24px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  backgroundColor: 'var(--bg-surface-light)',
};

const titleStyle: React.CSSProperties = {
  fontSize: '16px',
  fontWeight: 700,
  color: 'var(--text-primary)',
  margin: 0,
};

const statusStyle = (column: string): React.CSSProperties => {
  let color = 'var(--text-secondary)';
  let bg = 'var(--bg-surface-active)';
  if (column === 'progress') {
    color = 'var(--color-warning)';
    bg = 'var(--color-warning-bg)';
  } else if (column === 'review') {
    color = 'var(--accent)';
    bg = 'var(--accent-light)';
  } else if (column === 'done') {
    color = 'var(--color-success)';
    bg = 'var(--color-success-bg)';
  }
  return {
    fontSize: '9px',
    fontWeight: 700,
    padding: '2px 6px',
    borderRadius: 'var(--radius-sm)',
    color,
    backgroundColor: bg,
    alignSelf: 'flex-start',
    letterSpacing: '0.05em',
  };
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '6px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const contentStyle: React.CSSProperties = {
  flex: 1,
  padding: '24px',
  display: 'flex',
  gap: '24px',
  overflowY: 'auto',
};

const leftSectionStyle: React.CSSProperties = {
  flex: 3,
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
};

const rightSectionStyle: React.CSSProperties = {
  flex: 2,
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
  borderLeft: '1px solid var(--border)',
  paddingLeft: '24px',
};

const cardSectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  margin: 0,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
};

const descTextStyle: React.CSSProperties = {
  fontSize: '13px',
  color: 'var(--text-primary)',
  lineHeight: '1.6',
  whiteSpace: 'pre-wrap',
  margin: 0,
};

const criteriaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
};

const checkboxStyle: React.CSSProperties = {
  marginTop: '3px',
};

const fileChipStyle: React.CSSProperties = {
  fontSize: '11px',
  fontFamily: 'monospace',
  padding: '3px 8px',
  backgroundColor: 'var(--bg-surface-active)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
};

const mutedTextStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
  margin: 0,
  fontStyle: 'italic',
};

const metaGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '80px 1fr',
  rowGap: '10px',
  columnGap: '8px',
  marginTop: '8px',
};

const metaLabelStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-muted)',
};

const metaValStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  padding: '1px 6px',
  borderRadius: 'var(--radius-sm)',
  justifySelf: 'start',
};

const metaValTextStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-primary)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const labelBadgeStyle: React.CSSProperties = {
  fontSize: '10px',
  padding: '2px 6px',
  backgroundColor: 'var(--bg-surface-active)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
};

const sessionStatusStyle = (status: string): React.CSSProperties => {
  let color = 'var(--text-secondary)';
  let bg = 'var(--bg-surface-active)';

  if (['running', 'starting'].includes(status)) {
    color = 'var(--color-success)';
    bg = 'var(--color-success-bg)';
  } else if (['failed', 'stopped'].includes(status)) {
    color = 'var(--color-danger)';
    bg = 'var(--color-danger-bg)';
  }

  return {
    fontSize: '11px',
    fontWeight: 600,
    padding: '1px 6px',
    borderRadius: 'var(--radius-sm)',
    color,
    backgroundColor: bg,
    justifySelf: 'start',
  };
};

const footerStyle: React.CSSProperties = {
  padding: '16px 24px',
  borderTop: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface-light)',
  display: 'flex',
  justifyContent: 'flex-end',
};

const btnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  height: '36px',
  fontSize: '13px',
  fontWeight: 600,
  padding: '0 16px',
  borderRadius: 'var(--radius-md)',
  cursor: 'pointer',
};
