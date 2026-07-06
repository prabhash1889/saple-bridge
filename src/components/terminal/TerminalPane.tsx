import React, { memo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { Check, XCircle } from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { writeTextToClipboard } from '../../lib/clipboard';
import { useXtermSession, IS_WINDOWS_PTY } from './useXtermSession';
import { copyTerminalSelection } from './terminalClipboard';
import { TerminalPaneTitlebar } from './TerminalPaneTitlebar';
import { TerminalSearchBar } from './TerminalSearchBar';
import { TerminalPaneContextMenu, type TerminalContextMenuState } from './TerminalPaneContextMenu';

// Custom MIME so a pane drag-to-reorder is never mistaken for droppable text (which would
// paste the id into the terminal) and so unrelated file/text drags don't highlight panes.
const PANE_DND_MIME = 'application/x-saple-pane';

// Serialize a terminal's whole buffer (scrollback + viewport) to clean text — no ANSI codes,
// unlike the raw output buffer — for "Copy all output".
const serializeTerminalBuffer = (buffer: { length: number; getLine: (i: number) => { translateToString: (trim?: boolean) => string } | undefined }) => {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
};

interface TerminalPaneProps {
  sessionId: string;
  maximized?: boolean;
  // Whether this pane's workspace is the one currently on screen. Panes in hidden
  // workspaces stay mounted (so switching back never re-creates them) but give up their
  // WebGL renderer while off-screen — see useXtermSession.
  active?: boolean;
}

const TerminalPaneComponent: React.FC<TerminalPaneProps> = ({ sessionId, maximized, active = true }) => {
  const [searchOpen, setSearchOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);

  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const linkedTask = useKanbanStore((state) => state.tasks.find(t => t.terminalId === sessionId));
  const focusedPaneId = useTerminalStore((state) => state.focusedPaneId);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  const addPane = useTerminalStore((state) => state.addPane);
  const removePane = useTerminalStore((state) => state.removePane);
  const reorderPane = useTerminalStore((state) => state.reorderPane);
  const toggleMaximizePane = useTerminalStore((state) => state.toggleMaximizePane);
  const canAddPane = useTerminalStore((state) => state.canAddPane);
  const sessionInfo = useTerminalStore((state) => state.sessions[sessionId]);
  const isWaitingReview = useTerminalStore((state) => state.reviewPanes[sessionId]);
  const hasActivity = useTerminalStore((state) => Boolean(state.activityPanes[sessionId]));
  const hasExited = useTerminalStore((state) => Boolean(state.exitedPanes[sessionId]));
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

  const closeSearch = () => {
    setSearchOpen(false);
    terminalRef.current?.focus();
  };

  const handleContainerClick = () => {
    if (!isFocused) {
      setFocusedPane(sessionId);
    }
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

  const handleDragStart = (event: React.DragEvent) => {
    event.dataTransfer.setData(PANE_DND_MIME, sessionId);
    event.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PANE_DND_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (!isDropTarget) setIsDropTarget(true);
  };

  const handleDragLeave = () => setIsDropTarget(false);

  const handleDrop = (event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes(PANE_DND_MIME)) return;
    event.preventDefault();
    setIsDropTarget(false);
    const sourceId = event.dataTransfer.getData(PANE_DND_MIME);
    if (sourceId && sourceId !== sessionId) reorderPane(sourceId, sessionId);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    // Let native inputs (the search bar) keep their own context menu.
    if ((event.target as HTMLElement).closest('input')) return;
    event.preventDefault();
    setFocusedPane(sessionId);
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const notifyCopyFailed = () =>
    useNotificationStore
      .getState()
      .warning('Copy failed', 'The clipboard was busy or unavailable. Try again.');

  const handleContextCopy = () => {
    const term = terminalRef.current;
    if (term) copyTerminalSelection(term, writeTextToClipboard, { onCopyFailed: notifyCopyFailed });
  };

  const handleContextCopyAll = () => {
    const term = terminalRef.current;
    if (!term) return;
    const text = serializeTerminalBuffer(term.buffer.active);
    writeTextToClipboard(text).catch(notifyCopyFailed);
  };

  const handleContextPaste = () => {
    const term = terminalRef.current;
    if (!term) return;
    readText()
      .then((text) => {
        if (text) term.paste(text);
        term.focus();
      })
      .catch(() => {
        // Clipboard empty or non-text — nothing to paste.
      });
  };

  const handleContextClear = () => {
    terminalRef.current?.clear();
    terminalRef.current?.focus();
  };

  const handleContextSearch = () => setSearchOpen(true);

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
        hasActivity={hasActivity}
        hasExited={hasExited}
        isDropTarget={isDropTarget}
        onTitleAction={handleTitleAction}
        onAddPane={handleAddPane}
        onToggleMaximize={() => toggleMaximizePane(sessionId)}
        onRemovePane={handleRemovePane}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragLeave}
      />

      <div
        ref={containerRef}
        className="terminal-xterm-container"
      />

      {searchOpen && (
        <TerminalSearchBar searchAddonRef={searchAddonRef} onClose={closeSearch} />
      )}

      {contextMenu && (
        <TerminalPaneContextMenu
          position={contextMenu}
          hasSelection={Boolean(terminalRef.current?.hasSelection())}
          onCopy={handleContextCopy}
          onCopyAll={handleContextCopyAll}
          onPaste={handleContextPaste}
          onClear={handleContextClear}
          onSearch={handleContextSearch}
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
