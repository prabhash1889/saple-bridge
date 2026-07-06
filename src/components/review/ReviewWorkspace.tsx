import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GitPullRequest, RotateCcw, CheckCircle2, AlertTriangle, Play, RefreshCw, GitBranch
} from 'lucide-react';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { invoke } from '@tauri-apps/api/core';
import { useNotificationStore } from '../../stores/notificationStore';
import { VirtualizedTextViewer } from './VirtualizedTextViewer';
import { SplitDiffViewer } from './SplitDiffViewer';
import { ReviewFileList } from './ReviewFileList';
import { ReviewActionsPanel } from './ReviewActionsPanel';
import { PANE_WIDTH_LIMITS, useWorkspacePaneLayoutStore } from '../../stores/workspacePaneLayoutStore';

const statusPillClass = (status?: string) => {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'review';
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const KEYBOARD_RESIZE_STEP = 24;

interface GitBranchInfo {
  name: string;
  current: boolean;
}

// Local-branch dropdown for the Review room header. Checkout is guarded Rust-side:
// it refuses when the working tree is dirty, so it can never clobber un-reviewed changes.
const BranchSwitcher: React.FC<{ projectPath: string }> = ({ projectPath }) => {
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [switching, setSwitching] = useState(false);

  const loadBranches = useCallback(async () => {
    try {
      setBranches(await invoke<GitBranchInfo[]>('git_list_branches', { projectPath }));
    } catch {
      setBranches([]); // Non-git workspace: render nothing.
    }
  }, [projectPath]);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches]);

  const current = branches.find((b) => b.current)?.name ?? '';
  if (branches.length === 0) return null;

  const handleCheckout = async (branch: string) => {
    if (!branch || branch === current) return;
    setSwitching(true);
    try {
      await invoke('git_checkout_branch', { projectPath, branch });
      useNotificationStore.getState().success(`Switched to branch ${branch}`);
      await loadBranches();
      await useProjectStore.getState().refreshWorkspace();
    } catch (err) {
      useNotificationStore.getState().error('Branch switch failed', String(err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <label className="review-branch-switcher" title="Switch local branch (requires a clean working tree)">
      <GitBranch size={14} />
      <select
        value={current}
        disabled={switching}
        onChange={(e) => void handleCheckout(e.target.value)}
        aria-label="Switch git branch"
      >
        {branches.map((b) => (
          <option key={b.name} value={b.name}>{b.name}</option>
        ))}
      </select>
    </label>
  );
};

export const ReviewWorkspace: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const tasks = useKanbanStore((state) => state.tasks);
  const loadTasks = useKanbanStore((state) => state.loadTasks);
  const loadSessions = useAgentSessionStore((state) => state.loadSessions);

  const {
    reviews,
    activeTaskId,
    loading: reviewLoading,
    loadReviewRecord,
    createReviewRecord,
    refreshReviewRecord,
    submitReviewDecision,
    loadGitDiff,
    setActiveTaskId,
    setFileStaged,
    setFileViewed,
    commitStaged
  } = useReviewStore();

  const [activeTab, setActiveTab] = useState<'diff' | 'test'>('diff');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);

  const [diffSubTab, setDiffSubTab] = useState<'diff' | 'split' | 'code'>('diff');
  const [fullCode, setFullCode] = useState<string>('');
  const [loadingCode, setLoadingCode] = useState(false);

  const [rejecting, setRejecting] = useState(false);
  const [notes, setNotes] = useState('');
  const [submittingDecision, setSubmittingDecision] = useState(false);

  const [verificationCmd, setVerificationCmd] = useState('npm test');
  const [runningVerification, setRunningVerification] = useState(false);
  const [verificationResult, setVerificationResult] = useState<string | null>(null);
  const [memoryCreated, setMemoryCreated] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const paneLayout = useWorkspacePaneLayoutStore((state) =>
    currentProjectPath ? state.getLayout(currentProjectPath) : state.getLayout('__default__')
  );
  const setPaneLayout = useWorkspacePaneLayoutStore((state) => state.setLayout);

  const reviewTasks = useMemo(() => tasks.filter((task) => task.column === 'review'), [tasks]);
  const activeTask = tasks.find((task) => task.id === activeTaskId);
  const activeRecord = activeTaskId ? reviews[activeTaskId] : null;

  // Auto-select first task if none is selected
  useEffect(() => {
    if (!activeTaskId && reviewTasks.length > 0) {
      setActiveTaskId(reviewTasks[0].id);
    }
  }, [activeTaskId, reviewTasks, setActiveTaskId]);

  // Load review record when active task changes. Depend on the task's primitive fields, not
  // the `activeTask` object: background loadTasks polls rebuild the tasks array with fresh
  // object identities, and an object dep would re-run this effect — wiping the reviewer's
  // notes/selection below — even though nothing actually changed.
  const activeTaskSessionId = activeTask?.sessionId;
  useEffect(() => {
    if (!currentProjectPath || !activeTaskId) return;

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      loadReviewRecord(currentProjectPath, activeTaskId)
        .catch(async () => {
          if (cancelled) return;
          // If not found, attempt to auto-create review record from session
          if (activeTaskSessionId) {
            try {
              await createReviewRecord(currentProjectPath, activeTaskId, activeTaskSessionId);
            } catch (err) {
              console.error("Failed to auto-create review record:", err);
            }
          }
        });
    }, 0);

    // Reset state immediately so the room can paint before git/review work starts.
    setSelectedFile(null);
    setFileDiff('');
    setLoadingDiff(false);
    setDiffSubTab('diff');
    setFullCode('');
    setLoadingCode(false);
    setVerificationResult(null);
    setMemoryCreated(false);
    setRejecting(false);
    setNotes('');

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [activeTaskId, currentProjectPath, activeTaskSessionId, loadReviewRecord, createReviewRecord]);

  // Set default file when files list loads
  useEffect(() => {
    if (activeRecord && activeRecord.changedFiles.length > 0 && !selectedFile) {
      setSelectedFile(activeRecord.changedFiles[0].path);
    }
  }, [activeRecord, selectedFile]);

  // Load diff when active file changes
  useEffect(() => {
    if (currentProjectPath && selectedFile) {
      let cancelled = false;
      setLoadingDiff(true);
      const timeoutId = window.setTimeout(() => {
        loadGitDiff(currentProjectPath, selectedFile)
          .then((diff) => {
            if (cancelled) return;
            setFileDiff(diff);
            setLoadingDiff(false);
          })
          .catch((err) => {
            if (cancelled) return;
            setFileDiff(`Failed to load diff: ${err}`);
            setLoadingDiff(false);
          });
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(timeoutId);
      };
    }
  }, [selectedFile, currentProjectPath, activeTaskId, loadGitDiff]);

  // Load full file content when active file changes or sub-tab changes to code
  useEffect(() => {
    if (currentProjectPath && selectedFile && diffSubTab === 'code') {
      let cancelled = false;
      setLoadingCode(true);
      const timeoutId = window.setTimeout(() => {
        invoke<string>('read_text_file', {
          projectPath: currentProjectPath,
          filePath: selectedFile,
        })
          .then((code) => {
            if (cancelled) return;
            setFullCode(code);
            setLoadingCode(false);
          })
          .catch((err) => {
            if (cancelled) return;
            setFullCode(`Failed to load full file: ${err}`);
            setLoadingCode(false);
          });
      }, 0);

      return () => {
        cancelled = true;
        window.clearTimeout(timeoutId);
      };
    }
  }, [selectedFile, currentProjectPath, diffSubTab]);

  // Workspace-configured verification presets (Settings > Workspace); language
  // auto-detection stays as the fallback when none are configured.
  const verificationPresets = useProjectStore(
    (state) => state.workspaceConfig?.verificationPresets ?? [],
  );

  useEffect(() => {
    if (!activeRecord) return;
    if (verificationPresets.length > 0) {
      setVerificationCmd(verificationPresets[0]);
      return;
    }
    const hasCargo = activeRecord.changedFiles.some(f => f.path.endsWith('.rs') || f.path === 'Cargo.toml');
    const hasPy = activeRecord.changedFiles.some(f => f.path.endsWith('.py') || f.path === 'requirements.txt');
    if (hasCargo) {
      setVerificationCmd('cargo test');
    } else if (hasPy) {
      setVerificationCmd('pytest');
    } else {
      setVerificationCmd('npm test');
    }
  }, [activeRecord, verificationPresets]);

  if (!currentProjectPath) {
    return (
      <section className="room-empty-state">
        <GitPullRequest size={28} />
        <h2>Review Room</h2>
        <p>Open a workspace to inspect changed files, test output, agent summaries, and review decisions.</p>
      </section>
    );
  }

  const handleApprove = async () => {
    if (!currentProjectPath || !activeTaskId) return;
    setSubmittingDecision(true);
    try {
      await submitReviewDecision(currentProjectPath, activeTaskId, 'approve');
      await loadTasks(currentProjectPath, true);
      await loadSessions(currentProjectPath, true);
      setActiveTaskId(null);
    } catch (err) {
      useNotificationStore.getState().error(`Approval failed: ${String(err)}`);
    } finally {
      setSubmittingDecision(false);
    }
  };

  const handleReject = async () => {
    if (!currentProjectPath || !activeTaskId) return;
    if (!rejecting) {
      setRejecting(true);
      return;
    }
    if (!notes.trim()) {
      useNotificationStore.getState().warning('Please enter feedback notes describing the reason for rejection.');
      return;
    }
    setSubmittingDecision(true);
    try {
      await submitReviewDecision(currentProjectPath, activeTaskId, 'reject', notes);

      // If task had terminal session, notify shell PTY to resume
      if (activeTask && activeTask.terminalId) {
        try {
          await invoke('write_pty', {
            id: activeTask.terminalId,
            data: `\r# Review Rejected: ${notes.replace(/\r?\n/g, ' ')}. Resuming task...\r`
          });
        } catch (e) {
          console.warn("Could not write rejection to PTY:", e);
        }
      }

      await loadTasks(currentProjectPath, true);
      await loadSessions(currentProjectPath, true);
      setActiveTaskId(null);
    } catch (err) {
      useNotificationStore.getState().error(`Rejection failed: ${String(err)}`);
    } finally {
      setSubmittingDecision(false);
      setRejecting(false);
    }
  };

  const handleRefresh = async () => {
    if (!currentProjectPath || !activeTaskId) return;
    const sessionId = activeTask?.sessionId || activeRecord?.sessionId;
    if (!sessionId) {
      useNotificationStore.getState().warning('No agent session linked to this task; cannot refresh git state.');
      return;
    }
    setRefreshing(true);
    try {
      const record = await refreshReviewRecord(currentProjectPath, activeTaskId, sessionId);
      // Re-select the first changed file and reload its diff against the new state.
      const firstFile = record.changedFiles[0]?.path ?? null;
      setSelectedFile(firstFile);
      setFileDiff('');
      setFullCode('');
      if (firstFile) {
        setLoadingDiff(true);
        const diff = await loadGitDiff(currentProjectPath, firstFile);
        setFileDiff(diff);
        setLoadingDiff(false);
      }
    } catch (err) {
      useNotificationStore.getState().error(`Refresh failed: ${String(err)}`);
    } finally {
      setRefreshing(false);
    }
  };

  const stagedCount = activeRecord?.changedFiles.filter((f) => f.staged).length ?? 0;

  const handleToggleStaged = async (filePath: string, staged: boolean) => {
    if (!currentProjectPath || !activeTaskId) return;
    try {
      await setFileStaged(currentProjectPath, activeTaskId, filePath, staged);
    } catch (err) {
      useNotificationStore.getState().error(
        `Failed to ${staged ? 'stage' : 'unstage'} ${filePath}`,
        String(err)
      );
    }
  };

  const handleToggleViewed = async (filePath: string, viewed: boolean) => {
    if (!currentProjectPath || !activeTaskId) return;
    try {
      await setFileViewed(currentProjectPath, activeTaskId, filePath, viewed);
    } catch (err) {
      useNotificationStore.getState().error(`Failed to update viewed state for ${filePath}`, String(err));
    }
  };

  const handleCommit = async () => {
    if (!currentProjectPath || !commitMessage.trim() || stagedCount === 0) return;
    setCommitting(true);
    try {
      const summary = await commitStaged(currentProjectPath, commitMessage.trim());
      useNotificationStore.getState().success('Committed staged changes.', summary);
      setCommitMessage('');
      // Re-pull git status so committed files drop out of the changed list.
      await handleRefresh();
    } catch (err) {
      useNotificationStore.getState().error('Commit failed', String(err));
    } finally {
      setCommitting(false);
    }
  };

  // TRUST BOUNDARY: `verificationCmd` is executed verbatim in the operator's shell by the Rust
  // `run_verification_command` (see review.rs). This is intentional — it runs the user's own
  // build/test commands — but it is unsandboxed. The command is shown in the editable input and
  // the test-output header below before it runs, so the operator can inspect it first. Keep that
  // visibility; never auto-run a command sourced from project files.
  const handleRunVerification = async () => {
    if (!currentProjectPath || !activeTaskId) return;
    setRunningVerification(true);
    setVerificationResult(null);
    try {
      const output = await invoke<string>('run_verification_command', {
        projectPath: currentProjectPath,
        taskId: activeTaskId,
        commandStr: verificationCmd,
      });
      setVerificationResult(output);
      // Reload review record to update test output in store
      await loadReviewRecord(currentProjectPath, activeTaskId);
    } catch (err) {
      setVerificationResult(`Execution failed: ${err}`);
    } finally {
      setRunningVerification(false);
    }
  };

  const handleCreateMemory = async () => {
    if (!currentProjectPath || !activeRecord || !activeTask) return;
    try {
      const memoryContent = `# Review Decision: ${activeRecord.title}

**Task ID:** ${activeRecord.taskId}
**Status:** ${activeRecord.status.toUpperCase()}
**Role Assigned:** ${activeRecord.role}
**Date:** ${new Date(activeRecord.updatedAt).toLocaleString()}

## Changed Files Details
${activeRecord.changedFiles.map(f => `- **${f.path}** (${f.status}) [Inserts: ${f.insertions ?? 0}, Deletes: ${f.deletions ?? 0}]`).join('\n')}

## Review Context & Notes
${activeRecord.notes || 'No review notes provided. Task approved directly.'}

${activeRecord.testOutput ? `## Verification Execution Output\n\`\`\`\n${activeRecord.testOutput}\n\`\`\`` : ''}
`;

      await invoke('save_memory_node', {
        projectPath: currentProjectPath,
        id: `review-${activeTaskId}`,
        title: `Review: ${activeTask.title}`,
        category: 'review',
        tags: ['review', activeRecord.role],
        content: memoryContent,
      });
      setMemoryCreated(true);
    } catch (err) {
      useNotificationStore.getState().error(`Failed to save memory note: ${String(err)}`);
    }
  };

  // Check for unrelated files in git that are not covered by targetFiles.
  // A changed file is "related" when it exactly matches a target file, or sits
  // inside a target directory (segment-boundary prefix) — avoids substring false
  // matches like target "src" matching "source/x".
  const getUnrelatedFiles = () => {
    if (!activeRecord || !activeTask) return [];
    const targets = activeTask.targetFiles || [];
    if (targets.length === 0) return [];

    const normalize = (p: string) =>
      p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
    const normTargets = targets.map(normalize).filter(Boolean);

    return activeRecord.changedFiles.filter((f) => {
      const filePath = normalize(f.path);
      return !normTargets.some(
        (t) => filePath === t || filePath.startsWith(`${t}/`),
      );
    });
  };

  const unrelatedFiles = getUnrelatedFiles();

  const handleReviewQueueResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneLayout.reviewQueueWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setPaneLayout(currentProjectPath, {
        reviewQueueWidth: clamp(
          startWidth + moveEvent.clientX - startX,
          PANE_WIDTH_LIMITS.reviewQueue.min,
          PANE_WIDTH_LIMITS.reviewQueue.max,
        ),
      });
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleReviewActionsResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneLayout.reviewActionsWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setPaneLayout(currentProjectPath, {
        reviewActionsWidth: clamp(
          startWidth - (moveEvent.clientX - startX),
          PANE_WIDTH_LIMITS.reviewActions.min,
          PANE_WIDTH_LIMITS.reviewActions.max,
        ),
      });
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleReviewQueueResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setPaneLayout(currentProjectPath, {
      reviewQueueWidth: clamp(
        paneLayout.reviewQueueWidth + direction * KEYBOARD_RESIZE_STEP,
        PANE_WIDTH_LIMITS.reviewQueue.min,
        PANE_WIDTH_LIMITS.reviewQueue.max,
      ),
    });
  };

  const handleReviewActionsResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? 1 : -1;
    setPaneLayout(currentProjectPath, {
      reviewActionsWidth: clamp(
        paneLayout.reviewActionsWidth + direction * KEYBOARD_RESIZE_STEP,
        PANE_WIDTH_LIMITS.reviewActions.min,
        PANE_WIDTH_LIMITS.reviewActions.max,
      ),
    });
  };

  return (
    <section className="review-room review-room-container">
      <div className="room-header">
        <div>
          <p className="eyebrow">Human review gate</p>
          <h2>Review Room</h2>
          <p>Inspect changed files, run test verifications, add feedback, and approve/reject agent outputs.</p>
        </div>
        <div className="review-header-action">
          <BranchSwitcher projectPath={currentProjectPath} />
          <button className="secondary-action" onClick={() => setActiveView('kanban')}>
            <RotateCcw size={16} />
            Kanban Tasks
          </button>
        </div>
      </div>

      <div
        className="review-layout resizable-review-layout"
        style={{
          gridTemplateColumns: `${paneLayout.reviewQueueWidth}px 6px minmax(0, 1fr) 6px ${paneLayout.reviewActionsWidth}px`,
        }}
      >
        {/* Left Column: Review Queue */}
        <section className="surface review-queue">
          <div className="panel-heading">
            <GitPullRequest size={16} />
            <span>Review Queue</span>
          </div>
          <div className="review-queue-list">
            {reviewTasks.length === 0 ? (
              <div className="compact-empty">No tasks waiting for review.</div>
            ) : (
              reviewTasks.map((task) => {
                const record = reviews[task.id];
                const activeClass = task.id === activeTaskId ? 'active' : '';
                return (
                  <article
                    key={task.id}
                    className={`review-queue-item ${activeClass}`}
                    onClick={() => setActiveTaskId(task.id)}
                  >
                    <strong>{task.title}</strong>
                    <span>{task.agentConfig?.provider ?? 'unassigned'} - {task.agentConfig?.role ?? 'review'}</span>
                    {record && (
                      <span className="review-task-eyebrow eyebrow">
                        {record.changedFiles.length} files changed
                      </span>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>

        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize review queue"
          aria-valuemin={PANE_WIDTH_LIMITS.reviewQueue.min}
          aria-valuemax={PANE_WIDTH_LIMITS.reviewQueue.max}
          aria-valuenow={paneLayout.reviewQueueWidth}
          tabIndex={0}
          onMouseDown={handleReviewQueueResizeStart}
          onKeyDown={handleReviewQueueResizeKeyDown}
        />

        {/* Center Column: Diff & Verification Output */}
        <section className="surface review-main review-detail-panel">
          {!activeTaskId ? (
            <div className="review-empty-fill room-empty-state">
              <CheckCircle2 size={24} />
              <h3>Select a task from the review queue</h3>
            </div>
          ) : reviewLoading && !activeRecord ? (
            <div className="compact-empty">Loading review record...</div>
          ) : (
            <>
              <div className="review-detail-header">
                <div>
                  <h3 className="review-task-title">{activeTask?.title}</h3>
                  <span
                    className={`status-pill review-status-label ${statusPillClass(activeRecord?.status)}`}
                  >
                    Status: {activeRecord?.status ?? 'pending'}
                  </span>
                </div>
                <button
                  className="review-header-action secondary-action"
                  onClick={handleRefresh}
                  disabled={refreshing || reviewLoading}
                  title="Re-pull git status & diffs"
                >
                  <RefreshCw size={14} className={refreshing ? 'spinning' : undefined} />
                  <span>{refreshing ? 'Refreshing...' : 'Refresh'}</span>
                </button>
              </div>

              <div className="review-tabs">
                <button
                  className={`review-tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
                  onClick={() => setActiveTab('diff')}
                >
                  Files & Diffs
                </button>
                <button
                  className={`review-tab-btn ${activeTab === 'test' ? 'active' : ''}`}
                  onClick={() => setActiveTab('test')}
                >
                  Verification / Test Output
                </button>
              </div>

              {activeTab === 'diff' ? (
                // Tab 1: Diffs
                <>
                  <ReviewFileList
                    changedFiles={activeRecord?.changedFiles ?? []}
                    viewedFiles={activeRecord?.viewedFiles ?? []}
                    selectedFile={selectedFile}
                    onSelectFile={setSelectedFile}
                    onToggleStaged={(path, staged) => void handleToggleStaged(path, staged)}
                    onToggleViewed={(path, viewed) => void handleToggleViewed(path, viewed)}
                    stagedCount={stagedCount}
                    commitMessage={commitMessage}
                    onCommitMessageChange={setCommitMessage}
                    committing={committing}
                    onCommit={() => void handleCommit()}
                  />

                  {unrelatedFiles.length > 0 && (
                    <div className="warning-banner">
                      <div className="review-verify-heading">
                        <AlertTriangle size={14} />
                        <span>Warning: Unrelated Files Modified</span>
                      </div>
                      <span>
                        The agent modified files outside the target file list:
                        <ul className="review-verify-file-list">
                          {unrelatedFiles.slice(0, 3).map(f => (
                            <li key={f.path} className="review-verify-file-path">{f.path}</li>
                          ))}
                          {unrelatedFiles.length > 3 && <li>and {unrelatedFiles.length - 3} more...</li>}
                        </ul>
                      </span>
                    </div>
                  )}

                  {selectedFile && (
                    <div className="diff-subtab-bar">
                      <button
                        className={`diff-subtab-btn ${diffSubTab === 'diff' ? 'active' : ''}`}
                        onClick={() => setDiffSubTab('diff')}
                      >
                        Unified Diff
                      </button>
                      <button
                        className={`diff-subtab-btn ${diffSubTab === 'split' ? 'active' : ''}`}
                        onClick={() => setDiffSubTab('split')}
                      >
                        Split Diff
                      </button>
                      <button
                        className={`diff-subtab-btn ${diffSubTab === 'code' ? 'active' : ''}`}
                        onClick={() => setDiffSubTab('code')}
                      >
                        Full File Code
                      </button>
                    </div>
                  )}

                  <div className="diff-viewer">
                    {diffSubTab === 'diff' || diffSubTab === 'split' ? (
                      loadingDiff ? (
                        <div className="compact-empty">Loading diff...</div>
                      ) : !selectedFile ? (
                        <div className="compact-empty">Select a file to inspect its diff.</div>
                      ) : diffSubTab === 'split' ? (
                        <SplitDiffViewer diff={fileDiff} />
                      ) : (
                        <VirtualizedTextViewer text={fileDiff} mode="diff" />
                      )
                    ) : (
                      loadingCode ? (
                        <div className="compact-empty">Loading file code...</div>
                      ) : !selectedFile ? (
                        <div className="compact-empty">Select a file to inspect its code.</div>
                      ) : (
                        <VirtualizedTextViewer text={fullCode} mode="code" />
                      )
                    )}
                  </div>
                </>
              ) : (
                // Tab 2: Verification Output
                <div className="test-output-viewer">
                  {verificationPresets.length > 0 && (
                    <div className="verification-presets">
                      {verificationPresets.map((preset) => (
                        <button
                          key={preset}
                          className={`diff-subtab-btn ${verificationCmd === preset ? 'active' : ''}`}
                          onClick={() => setVerificationCmd(preset)}
                          disabled={runningVerification}
                          title="Use this verification preset"
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="verification-input-row">
                    <input
                      type="text"
                      value={verificationCmd}
                      onChange={(e) => setVerificationCmd(e.target.value)}
                      placeholder="e.g. npm test, cargo check"
                      disabled={runningVerification}
                    />
                    <button
                      className="review-verify-btn primary"
                      onClick={handleRunVerification}
                      disabled={runningVerification || submittingDecision}
                    >
                      {runningVerification ? (
                        <span>Running...</span>
                      ) : (
                        <>
                          <Play size={14} />
                          <span>Verify</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="test-output-terminal">
                    {runningVerification ? (
                      "Running verification command...\n> " + verificationCmd
                    ) : verificationResult ? (
                      verificationResult
                    ) : activeRecord?.testOutput ? (
                      activeRecord.testOutput
                    ) : (
                      "No verification logs captured yet. Run verify or inspect terminal output."
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </section>

        <div
          className="pane-splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize review actions"
          aria-valuemin={PANE_WIDTH_LIMITS.reviewActions.min}
          aria-valuemax={PANE_WIDTH_LIMITS.reviewActions.max}
          aria-valuenow={paneLayout.reviewActionsWidth}
          tabIndex={0}
          onMouseDown={handleReviewActionsResizeStart}
          onKeyDown={handleReviewActionsResizeKeyDown}
        />

        {/* Right Column: Actions & Handoff Info */}
        <ReviewActionsPanel
          activeTask={activeTask}
          activeRecord={activeRecord}
          rejecting={rejecting}
          notes={notes}
          onNotesChange={setNotes}
          submittingDecision={submittingDecision}
          runningVerification={runningVerification}
          memoryCreated={memoryCreated}
          onApprove={() => void handleApprove()}
          onReject={() => void handleReject()}
          onCancelReject={() => { setRejecting(false); setNotes(''); }}
          onCreateMemory={() => void handleCreateMemory()}
        />
      </div>
    </section>
  );
};
