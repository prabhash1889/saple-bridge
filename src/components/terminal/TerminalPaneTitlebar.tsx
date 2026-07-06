import React from 'react';
import { GitBranch, Maximize2, Minimize2, X } from 'lucide-react';

interface TerminalPaneTitlebarProps {
  title: string;
  maximized?: boolean;
  canCreatePane: boolean;
  // Output arrived while this pane was unfocused (activity dot).
  hasActivity?: boolean;
  // The pane's PTY child has exited (exit badge).
  hasExited?: boolean;
  // Another pane is being dragged over this one (drop-target highlight).
  isDropTarget?: boolean;
  // Wraps each action: stops propagation and focuses the pane before running it.
  onTitleAction: (event: React.MouseEvent<HTMLButtonElement>, action: () => void | Promise<void>) => void;
  onAddPane: () => void;
  onToggleMaximize: () => void;
  onRemovePane: () => void;
  // Native drag-to-reorder handlers, applied to the title grip.
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: (event: React.DragEvent) => void;
}

export const TerminalPaneTitlebar: React.FC<TerminalPaneTitlebarProps> = ({
  title,
  maximized,
  canCreatePane,
  hasActivity,
  hasExited,
  isDropTarget,
  onTitleAction,
  onAddPane,
  onToggleMaximize,
  onRemovePane,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
}) => (
  <div
    className={`terminal-pane-titlebar${isDropTarget ? ' terminal-pane-titlebar-drop' : ''}`}
    onDragOver={onDragOver}
    onDragLeave={onDragLeave}
    onDrop={onDrop}
  >
    {/* The title doubles as the drag grip for reordering panes. */}
    <div
      className="terminal-pane-title"
      title={`${title} — drag to reorder`}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {hasActivity && !hasExited && (
        <span className="terminal-pane-activity-dot" aria-label="New output" title="New output since last focus" />
      )}
      <span>{title}</span>
      {hasExited && <span className="terminal-pane-exit-badge">exited</span>}
    </div>
    <div className="terminal-pane-title-actions">
      <button
        className="terminal-pane-title-button"
        onClick={(e) => onTitleAction(e, onAddPane)}
        disabled={!canCreatePane}
        title={canCreatePane ? 'Open matching terminal pane' : 'Pane limit reached'}
        aria-label="Open matching terminal pane"
      >
        <GitBranch size={14} />
      </button>
      <button
        className="terminal-pane-title-button"
        onClick={(e) => onTitleAction(e, onToggleMaximize)}
        title={maximized ? 'Restore to grid' : 'Maximize this pane'}
        aria-label={maximized ? 'Restore terminal pane to grid' : 'Maximize terminal pane'}
      >
        {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
      </button>
      <button
        className="terminal-pane-title-button"
        onClick={(e) => onTitleAction(e, onRemovePane)}
        title="Close this terminal pane"
        aria-label="Close this terminal pane"
      >
        <X size={14} />
      </button>
    </div>
  </div>
);
