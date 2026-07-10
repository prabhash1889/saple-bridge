import React from 'react';
import { GitBranch, Maximize2, Minimize2, X } from 'lucide-react';

interface TerminalPaneTitlebarProps {
  title: string;
  maximized?: boolean;
  canCreatePane: boolean;
  // Unfocused pane produced output since it was last focused — shows an unobtrusive dot.
  hasActivity?: boolean;
  // PTY child has exited — shows an "exited" badge instead of a silently dead pane.
  exited?: boolean;
  // Claude panes only: percent of the context window still free (null until known).
  contextLeft?: number | null;
  // Wraps each action: stops propagation and focuses the pane before running it.
  onTitleAction: (event: React.MouseEvent<HTMLButtonElement>, action: () => void | Promise<void>) => void;
  onAddPane: () => void;
  onToggleMaximize: () => void;
  onRemovePane: () => void;
}

export const TerminalPaneTitlebar: React.FC<TerminalPaneTitlebarProps> = ({
  title,
  maximized,
  canCreatePane,
  hasActivity,
  exited,
  contextLeft,
  onTitleAction,
  onAddPane,
  onToggleMaximize,
  onRemovePane,
}) => (
  <div className="terminal-pane-titlebar">
    <div className="terminal-pane-title" title={title}>
      {hasActivity && (
        <span className="terminal-pane-activity-dot" title="New output" aria-label="New output since last focus" />
      )}
      <span>{title}</span>
      {exited && <span className="terminal-pane-exit-badge">exited</span>}
    </div>
    <div className="terminal-pane-title-actions">
      {typeof contextLeft === 'number' && (
        <span
          className="terminal-context-badge"
          data-level={contextLeft <= 10 ? 'low' : contextLeft <= 30 ? 'warn' : 'ok'}
          title={`Claude context remaining: ${contextLeft}%`}
          aria-label={`Claude context remaining: ${contextLeft}%`}
        >
          <span className="terminal-context-meter" aria-hidden="true">
            <span className="terminal-context-meter-fill" style={{ width: `${contextLeft}%` }} />
          </span>
          {contextLeft}%
        </span>
      )}
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
