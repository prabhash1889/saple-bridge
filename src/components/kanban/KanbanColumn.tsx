import React, { memo, useCallback, useRef, useState } from 'react';
import { Task, TaskColumn, useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { TaskCard } from './TaskCard';

interface KanbanColumnProps {
  id: TaskColumn;
  title: string;
  tasks: Task[];
  wipLimit?: number;
  selectedTaskId?: string | null;
  onEditTask: (task: Task) => void;
  onViewTask: (task: Task) => void;
}

const KanbanColumnComponent: React.FC<KanbanColumnProps> = ({ id, title, tasks, wipLimit, selectedTaskId, onEditTask, onViewTask }) => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const reorderTask = useKanbanStore((state) => state.reorderTask);

  // Insertion index within this column's list (0..tasks.length), or null when not hovering.
  const [indicatorIndex, setIndicatorIndex] = useState<number | null>(null);
  const isDragOver = indicatorIndex !== null;
  const dragDepth = useRef(0);

  const clearIndicator = useCallback(() => {
    dragDepth.current = 0;
    setIndicatorIndex(null);
  }, []);

  const handleColumnDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); // Required to allow dropping.
    // Default to end-of-column unless a card handler refines it.
    setIndicatorIndex((prev) => (prev === null ? tasks.length : prev));
  }, [tasks.length]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current += 1;
  }, []);

  const handleDragLeave = useCallback(() => {
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIndicatorIndex(null);
    }
  }, []);

  const handleCardDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const isBottomHalf = e.clientY - rect.top > rect.height / 2;
    setIndicatorIndex(isBottomHalf ? index + 1 : index);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain');
    const target = indicatorIndex;
    clearIndicator();
    if (!taskId || !currentProjectPath) return;
    // Resolve the insertion anchor: the task we should land before, or null for end.
    const beforeId = target !== null && target < tasks.length ? tasks[target].id : null;
    await reorderTask(currentProjectPath, taskId, id, beforeId);
  }, [clearIndicator, currentProjectPath, id, indicatorIndex, reorderTask, tasks]);

  return (
    <div
      onDragOver={handleColumnDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={columnStyle(isDragOver)}
    >
      {/* Column Header */}
      <div style={headerStyle(id)}>
        <span style={titleStyle}>{title}</span>
        <span
          style={counterStyle(wipLimit !== undefined && tasks.length > wipLimit)}
          title={wipLimit !== undefined ? `${tasks.length} of ${wipLimit} WIP limit` : undefined}
        >
          {wipLimit !== undefined ? `${tasks.length}/${wipLimit}` : tasks.length}
        </span>
      </div>

      {/* Task Card List */}
      <div style={cardListStyle}>
        {tasks.length > 0 ? (
          <>
            {tasks.map((task, index) => (
              <div
                key={task.id}
                data-task-index={index}
                onDragOver={(e) => handleCardDragOver(e, index)}
                style={cardSlotStyle}
              >
                {indicatorIndex === index && <div style={insertionLineStyle} />}
                <TaskCard task={task} selected={task.id === selectedTaskId} onEdit={onEditTask} onClick={onViewTask} />
              </div>
            ))}
            {indicatorIndex === tasks.length && <div style={insertionLineStyle} />}
          </>
        ) : (
          <div style={emptyColumnStyle(isDragOver)}>Drop tasks here</div>
        )}
      </div>
    </div>
  );
};

export const KanbanColumn = memo(KanbanColumnComponent);

/* --- Inline CSS Styles --- */

const columnStyle = (isDragOver: boolean): React.CSSProperties => ({
  flex: 1,
  backgroundColor: isDragOver ? 'var(--bg-surface-light)' : 'var(--bg-surface)',
  border: `1px solid ${isDragOver ? 'var(--accent)' : 'var(--border)'}`,
  borderRadius: 'var(--radius-lg)',
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minWidth: '250px',
  maxWidth: '350px',
  overflow: 'hidden',
  transition: 'border-color 0.15s, background-color 0.15s',
});

const headerStyle = (id: TaskColumn): React.CSSProperties => {
  let borderTopColor = 'var(--text-muted)';
  if (id === 'backlog') borderTopColor = 'var(--text-secondary)';
  else if (id === 'progress') borderTopColor = 'var(--color-warning)';
  else if (id === 'review') borderTopColor = 'var(--accent)';
  else if (id === 'done') borderTopColor = 'var(--color-success)';

  return {
    padding: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottom: '1px solid var(--border)',
    borderTop: `3px solid ${borderTopColor}`,
    backgroundColor: 'var(--bg-surface-light)',
  };
};

const titleStyle: React.CSSProperties = {
  fontSize: '14px',
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const counterStyle = (overLimit: boolean): React.CSSProperties => ({
  fontSize: '11px',
  fontWeight: 600,
  color: overLimit ? 'var(--color-warning)' : 'var(--text-secondary)',
  backgroundColor: overLimit ? 'var(--color-warning-bg)' : 'var(--bg-surface-active)',
  padding: '2px 8px',
  borderRadius: 'var(--radius-full)',
  border: `1px solid ${overLimit ? 'var(--color-warning)' : 'var(--border)'}`,
});

const cardListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '16px',
  overflowY: 'auto',
  flex: 1,
  height: '100%',
};

const cardSlotStyle: React.CSSProperties = {
  position: 'relative',
};

const insertionLineStyle: React.CSSProperties = {
  height: '2px',
  borderRadius: '2px',
  backgroundColor: 'var(--accent)',
  margin: '-7px 0 5px 0',
  boxShadow: '0 0 6px rgba(93, 95, 239, 0.6)',
};

const emptyColumnStyle = (isDragOver: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100px',
  border: `1.5px dashed ${isDragOver ? 'var(--accent)' : 'var(--border)'}`,
  borderRadius: 'var(--radius-md)',
  fontSize: '12px',
  color: isDragOver ? 'var(--accent)' : 'var(--text-muted)',
  textAlign: 'center',
  transition: 'border-color 0.15s, color 0.15s',
});
