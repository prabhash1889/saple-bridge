import React, { memo, useCallback } from 'react';
import { Play, Terminal, Edit2, Trash2, Shield, FileText, ListChecks } from 'lucide-react';
import { Task, TaskColumn, useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { useProviderStore } from '../../stores/providerStore';
import { createId } from '../../lib/id';
import { invoke } from '@tauri-apps/api/core';
import { useNotificationStore } from '../../stores/notificationStore';

interface TaskCardProps {
  task: Task;
  onEdit: (task: Task) => void;
  onClick: (task: Task) => void;
}

const TaskCardComponent: React.FC<TaskCardProps> = ({ task, onEdit, onClick }) => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const deleteTask = useKanbanStore((state) => state.deleteTask);
  const updateTask = useKanbanStore((state) => state.updateTask);
  const moveTask = useKanbanStore((state) => state.moveTask);
  const addPane = useTerminalStore((state) => state.addPane);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  const isRunning = useTerminalStore((state) => Boolean(task.terminalId && state.sessions[task.terminalId]));

  const handleDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.setData('text/plain', task.id);
  }, [task.id]);

  const handleLaunchAgent = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentProjectPath) return;

    const provider = task.agentConfig?.provider || 'codex';
    const isProviderReady = useProviderStore.getState().isReady(provider);

    if (!isProviderReady) {
      useNotificationStore.getState().error(`Provider "${provider}" is not configured or authenticated. Please configure it in Settings.`);
      return;
    }

    try {
      const sessionId = createId('agent');
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

## Memory & MCP Instructions
You can read and write workspace memories under the \`.saple/memory\` directory using your memory tools or the MCP memory server (saple-memory). Keep the project knowledge updated.

## Review Signal Instructions
When you have finished the task and verified it, print a clear signal indicating completion.
You MUST output one of the following exact review trigger patterns on a line by itself:
- [REVIEW_REQUESTED]
- ## REVIEW REQUIRED
- Task complete. Review required.
`;

      // 1. Write prompt file to project workspace
      await invoke('write_project_file', {
        projectPath: currentProjectPath,
        filePath: promptPath,
        content: promptContent,
      });

      // 2. Create a new terminal pane for this agent with model and prompt file redirection
      const paneId = await addPane(currentProjectPath, provider, model, promptPath);
      
      // 3. Create the AgentSession in store
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

      // 4. Update task with the terminal ID, sessionId, and move to In Progress column
      await updateTask(currentProjectPath, task.id, { 
        terminalId: paneId, 
        sessionId: session.id,
        column: 'progress' 
      });

      // 5. Rename terminal session to match the task title and link agentSessionId
      useTerminalStore.getState().updateSession(paneId, { 
        name: `${provider.toUpperCase()} Agent: ${task.title}`,
        agentSessionId: session.id
      });

    } catch (error) {
      console.error('Failed to launch agent:', error);
      useNotificationStore.getState().error(`Failed to launch agent: ${String(error)}`);
    }
  }, [addPane, currentProjectPath, task, updateTask]);

  const handleViewTerminal = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.terminalId && useTerminalStore.getState().sessions[task.terminalId]) {
      setFocusedPane(task.terminalId);
      useProjectStore.getState().setActiveView('terminals');
    }
  }, [setFocusedPane, task.terminalId]);

  const handleMoveTask = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation();
    if (!currentProjectPath) return;
    void moveTask(currentProjectPath, task.id, e.target.value as TaskColumn);
  }, [currentProjectPath, moveTask, task.id]);

  return (
    <div 
      draggable 
      onDragStart={handleDragStart}
      onClick={() => onClick(task)}
      style={cardStyle}
    >
      {/* Title & Actions */}
      <div style={cardHeaderStyle}>
        <span style={titleStyle}>{task.title}</span>
        <div style={actionsStyle}>
          <label className="kanban-card-move-control" onClick={(e) => e.stopPropagation()}>
            <span className="visually-hidden">Move {task.title} to column</span>
            <select
              value={task.column}
              onChange={handleMoveTask}
              aria-label={`Move ${task.title} to column`}
              disabled={!currentProjectPath}
            >
              <option value="backlog">Backlog</option>
              <option value="progress">In progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
            </select>
          </label>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              onEdit(task);
            }} 
            style={iconBtnStyle} 
            title="Edit Task"
            aria-label={`Edit ${task.title}`}
          >
            <Edit2 size={12} />
          </button>
          <button 
            onClick={(e) => {
              e.stopPropagation();
              if (currentProjectPath) deleteTask(currentProjectPath, task.id);
            }} 
            style={dangerIconBtnStyle} 
            title="Delete Task"
            aria-label={`Delete ${task.title}`}
          >
            <Trash2 size={12} />
          </button>
        </div>
      </div>

      {/* Description */}
      {task.description ? <p style={descStyle}>{task.description}</p> : null}

      {/* Meta row: priority + counts */}
      <div style={metaRowStyle}>
        <span style={priorityPillStyle(task.priority)}>
          <span style={priorityDotStyle(task.priority)} />
          {task.priority}
        </span>
        {task.targetFiles && task.targetFiles.length > 0 && (
          <span style={metaCountStyle} title={`${task.targetFiles.length} target file(s)`}>
            <FileText size={11} />
            {task.targetFiles.length}
          </span>
        )}
        {task.acceptanceCriteria && task.acceptanceCriteria.length > 0 && (
          <span style={metaCountStyle} title={`${task.acceptanceCriteria.length} acceptance criteria`}>
            <ListChecks size={11} />
            {task.acceptanceCriteria.length}
          </span>
        )}
      </div>

      {/* Role Badge & Launch action */}
      <div style={footerStyle}>
        <div style={badgeContainerStyle}>
          {task.agentConfig && (
            <span style={roleBadgeStyle(task.agentConfig.role)}>
              <Shield size={10} />
              {task.agentConfig.role}
            </span>
          )}
          {task.labels.map(label => (
            <span key={label} style={labelBadgeStyle}>
              {label}
            </span>
          ))}
        </div>

        {/* Launcher actions */}
        {isRunning ? (
          <button onClick={handleViewTerminal} style={runningBtnStyle}>
            <Terminal size={12} />
            <span>Running</span>
          </button>
        ) : (
          <button 
            onClick={handleLaunchAgent} 
            className="primary" 
            style={launchBtnStyle}
            disabled={!currentProjectPath}
          >
            <Play size={12} />
            <span>Launch</span>
          </button>
        )}
      </div>
    </div>
  );
};

export const TaskCard = memo(TaskCardComponent);

/* --- Inline CSS Styles --- */

const cardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface-light)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px',
  cursor: 'grab',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  boxShadow: 'var(--shadow-sm)',
  transition: 'border-color 0.15s, background-color 0.15s',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '8px',
};

const titleStyle: React.CSSProperties = {
  fontSize: '13.5px',
  fontWeight: 600,
  color: 'var(--text-primary)',
  lineHeight: '1.4',
};

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '4px',
};

const iconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '4px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const dangerIconBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: '4px',
  color: 'var(--text-muted)',
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const descStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary)',
  lineHeight: '1.5',
  display: '-webkit-box',
  WebkitLineClamp: 3,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const metaRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
};

const priorityColor = (priority: string): string => {
  if (priority === 'urgent') return 'var(--color-danger)';
  if (priority === 'high') return 'var(--color-warning)';
  if (priority === 'low') return 'var(--text-muted)';
  return 'var(--color-info)'; // normal
};

const priorityPillStyle = (priority: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  fontSize: '10px',
  fontWeight: 600,
  textTransform: 'capitalize',
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  color: priorityColor(priority),
  backgroundColor: 'var(--bg-surface-active)',
  border: '1px solid var(--border)',
});

const priorityDotStyle = (priority: string): React.CSSProperties => ({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  backgroundColor: priorityColor(priority),
});

const metaCountStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  fontSize: '11px',
  color: 'var(--text-muted)',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '12px',
  marginTop: '4px',
};

const badgeContainerStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
};

const roleBadgeStyle = (role: string): React.CSSProperties => {
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

  return {
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase',
    padding: '2px 6px',
    borderRadius: 'var(--radius-sm)',
    color,
    backgroundColor: bg,
    border: '1px solid transparent',
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
  };
};

const labelBadgeStyle: React.CSSProperties = {
  fontSize: '10px',
  padding: '2px 6px',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  backgroundColor: 'var(--bg-surface-active)',
  border: '1px solid var(--border)',
};

const launchBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
  height: '24px',
  flexShrink: 0,
};

const runningBtnStyle: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
  height: '24px',
  flexShrink: 0,
  backgroundColor: 'var(--color-success-bg)',
  borderColor: 'var(--color-success)',
  color: 'var(--color-success)',
};
