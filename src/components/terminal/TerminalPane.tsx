import React, { memo, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { writeTextToClipboard } from '../../lib/clipboard';
import { contextLeftPercent, type ClaudeContextUsage } from '../../lib/claudeContext';
import { useXtermSession, IS_WINDOWS_PTY } from './useXtermSession';
import { copyTerminalSelection } from './terminalClipboard';
import { TerminalPaneTitlebar } from './TerminalPaneTitlebar';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalContextMenu } from './TerminalContextMenu';

interface TerminalPaneProps {
  sessionId: string;
  maximized?: boolean;
  // Whether this pane's workspace is the one currently on screen. Panes in hidden
  // workspaces stay mounted (so switching back never re-creates them) but give up their
  // WebGL renderer while off-screen — see useXtermSession.
  active?: boolean;
}

// Transcript tail poll cadence for the Claude context badge. Reads ~64KB from disk per
// tick per Claude pane; 4s keeps the number fresh without measurable cost.
const CONTEXT_POLL_MS = 4000;

const TerminalPaneComponent: React.FC<TerminalPaneProps> = ({ sessionId, maximized, active = true }) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [hasActivity, setHasActivity] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextLeft, setContextLeft] = useState<number | null>(null);

  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const linkedTask = useKanbanStore((state) => state.tasks.find(t => t.terminalId === sessionId));
  const focusedPaneId = useTerminalStore((state) => state.focusedPaneId);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  const addPane = useTerminalStore((state) => state.addPane);
  const removePane = useTerminalStore((state) => state.removePane);
  const toggleMaximizePane = useTerminalStore((state) => state.toggleMaximizePane);
  const canAddPane = useTerminalStore((state) => state.canAddPane);
  const sessionInfo = useTerminalStore((state) => state.sessions[sessionId]);
  const isWaitingReview = useTerminalStore((state) => state.reviewPanes[sessionId]);
  const exited = useTerminalStore((state) => Boolean(state.exitedPanes[sessionId]));
  const resolveReview = useTerminalStore((state) => state.resolveReview);

  const setActiveTaskId = useReviewStore((state) => state.setActiveTaskId);
  const createReviewRecord = useReviewStore((state) => state.createReviewRecord);
  const submitReviewDecision = useReviewStore((state) => state.submitReviewDecision);

  const isFocused = focusedPaneId === sessionId;
  const canCreatePane = Boolean(currentProjectPath && canAddPane());

  const { containerRef, terminalRef, searchAddonRef } = useXtermSession({
    sessionId,
    active,
    isFocused,
    onSearchOpen: () => setSearchOpen(true),
  });

  // Activity dot: while this pane is unfocused, light it on the first output that arrives
  // and clear it the moment it regains focus. Subscribing (not a store selector) keeps the
  // per-frame output flush off React's reactive path. Only sets state on the false->true
  // edge, so a busy pane doesn't re-render every frame.
  useEffect(() => {
    if (isFocused) {
      setHasActivity(false);
      return;
    }
    let lit = false;
    const unsubscribe = useTerminalStore.getState().subscribeOutput(sessionId, () => {
      if (!lit) {
        lit = true;
        setHasActivity(true);
      }
    });
    return unsubscribe;
  }, [isFocused, sessionId]);

  // Claude context badge: poll this session's transcript for the latest usage while the
  // pane's workspace is on screen. Errors keep the last shown value (transcript may not
  // exist yet right after spawn).
  const claudeSessionId = sessionInfo?.aiProvider === 'claude' ? sessionInfo.claudeSessionId : undefined;
  const claudeCwd = sessionInfo?.cwd;
  const claudeSpawnedAt = sessionInfo?.spawnedAt;
  useEffect(() => {
    if (!claudeSessionId || !active || exited) return;
    let cancelled = false;
    const poll = () => {
      invoke<ClaudeContextUsage | null>('get_claude_context_usage', {
        cwd: claudeCwd ?? '',
        sessionUuid: claudeSessionId,
        spawnedAtMs: claudeSpawnedAt,
      })
        .then((usage) => {
          if (!cancelled && usage) setContextLeft(contextLeftPercent(usage.usedTokens, usage.model));
        })
        .catch(() => {
          // Transcript missing or unreadable this tick - keep the last value.
        });
    };
    poll();
    const timer = window.setInterval(poll, CONTEXT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [claudeSessionId, claudeCwd, claudeSpawnedAt, active, exited]);

  const closeSearch = () => {
    setSearchOpen(false);
    terminalRef.current?.focus();
  };

  const handleContainerClick = () => {
    if (!isFocused) {
      setFocusedPane(sessionId);
    }
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    if (!isFocused) setFocusedPane(sessionId);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const handleContextCopy = () => {
    const term = terminalRef.current;
    if (term) copyTerminalSelection(term, writeTextToClipboard);
  };

  const handleContextPaste = () => {
    const term = terminalRef.current;
    if (!term) return;
    void readText()
      .then((text) => {
        if (text) term.paste(text);
      })
      .catch(() => {
        // Clipboard empty or non-text — nothing to paste.
      });
  };

  const handleContextClear = () => {
    terminalRef.current?.clear();
  };

  const handleTitleAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void | Promise<void>) => {
    event.stopPropagation();
    setFocusedPane(sessionId);
    void action();
  };

  const handleAddPane = () => {
    const cwd = sessionInfo?.workspacePath || sessionInfo?.cwd || currentProjectPath;
    if (!cwd || !canAddPane()) return;
    // Inherit the parent's model too (matches splitPane's inheritance) — passing undefined
    // here dropped the model and relaunched the provider's default.
    void addPane(cwd, sessionInfo?.aiProvider, sessionInfo?.model, undefined, sessionInfo?.customCommand);
  };

  const handleRemovePane = () => {
    void removePane(sessionId);
  };

  const handleApprove = async () => {
    if (!linkedTask || !currentProjectPath) return;
    try {
      await createReviewRecord(currentProjectPath, linkedTask.id, sessionId);
      await submitReviewDecision(currentProjectPath, linkedTask.id, 'approve');
      resolveReview(sessionId);
      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      await useAgentSessionStore.getState().loadSessions(currentProjectPath, true);
    } catch (err) {
      console.error('Approve failed:', err);
    }
    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  };

  const handleReject = async () => {
    if (!linkedTask || !currentProjectPath) return;
    try {
      await createReviewRecord(currentProjectPath, linkedTask.id, sessionId);
      await submitReviewDecision(currentProjectPath, linkedTask.id, 'reject', 'Rejected from terminal overlay');
      resolveReview(sessionId);

      try {
        await invoke('write_pty', {
          id: sessionId,
          data: '\r# Review Rejected. Resuming task correction...\r'
        });
      } catch (e) {
        console.error('Failed to notify shell:', e);
      }

      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      await useAgentSessionStore.getState().loadSessions(currentProjectPath, true);
    } catch (err) {
      console.error('Reject failed:', err);
    }

    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  };

  const paneColor = sessionInfo?.groupColor || '#5D5FEF';
  // Only Claude Code shows a live, dynamic title — it mirrors the OSC title its CLI sets
  // (current task, etc.) into dynamicTitle. Every other pane shows the name of the folder
  // it was spawned in, since their CLIs emit noisy titles (Pi spams its startup command;
  // plain shells emit the full cwd path).
  const shellLabel = IS_WINDOWS_PTY ? 'PowerShell' : 'Terminal';
  const folderName =
    sessionInfo?.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || shellLabel;
  const paneTitle =
    sessionInfo?.aiProvider === 'claude'
      ? sessionInfo?.dynamicTitle || 'Claude Code'
      : folderName;

  return (
    <div
      onClick={handleContainerClick}
      onContextMenu={handleContextMenu}
      className={`terminal-pane ${maximized ? 'terminal-pane-maximized' : ''}`}
      style={{
        '--terminal-pane-color': paneColor,
      } as React.CSSProperties}
      data-focused={isFocused ? 'true' : 'false'}
    >
      <TerminalPaneTitlebar
        title={paneTitle}
        maximized={maximized}
        canCreatePane={canCreatePane}
        hasActivity={hasActivity && !isFocused}
        exited={exited}
        contextLeft={claudeSessionId ? contextLeft : null}
        onTitleAction={handleTitleAction}
        onAddPane={handleAddPane}
        onToggleMaximize={() => toggleMaximizePane(sessionId)}
        onRemovePane={handleRemovePane}
      />

      <div
        ref={containerRef}
        className="terminal-xterm-container"
      />

      {searchOpen && (
        <TerminalSearchBar searchAddonRef={searchAddonRef} onClose={closeSearch} />
      )}

      {contextMenu && (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canCopy={Boolean(terminalRef.current?.hasSelection())}
          onCopy={handleContextCopy}
          onPaste={handleContextPaste}
          onClear={handleContextClear}
          onSearch={() => setSearchOpen(true)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {isWaitingReview && linkedTask && (
        <div className="terminal-review-overlay">
          <div className="terminal-review-content">
            <div className="terminal-review-title">Review Gate: {linkedTask.title}</div>
            <div className="terminal-review-description">Agent execution complete. Verify changes before committing.</div>
          </div>
          <div className="terminal-review-actions">
            <button
              onClick={() => {
                setActiveTaskId(linkedTask.id);
                setActiveView('review');
              }}
              className="terminal-review-open-btn terminal-review-open-room secondary"
            >
              Open Review Room
            </button>
            <button onClick={handleReject} className="terminal-review-reject">
              <XCircle size={14} />
              <span>Reject</span>
            </button>
            <button onClick={handleApprove} className="primary terminal-review-approve">
              <Check size={14} />
              <span>Approve</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const TerminalPane = memo(TerminalPaneComponent);
