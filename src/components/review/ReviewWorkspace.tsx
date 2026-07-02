import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  GitPullRequest, RotateCcw, CheckCircle2, AlertTriangle,
  Terminal, ShieldAlert, Check, XCircle, Award, FileText, Play, RefreshCw
} from 'lucide-react';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { invoke } from '@tauri-apps/api/core';
import { useNotificationStore } from '../../stores/notificationStore';

const REVIEW_LINE_HEIGHT = 20;
const REVIEW_MIN_VIEWPORT_HEIGHT = 200;
const REVIEW_OVERSCAN_LINES = 12;

const statusPillClass = (status?: string) => {
  if (status === 'approved') return 'success';
  if (status === 'rejected') return 'danger';
  return 'review';
};

const getDiffLineClass = (line: string) => {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-line-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-line-deleted';
  if (line.startsWith('@@')) return 'diff-line-meta';
  return 'diff-line-normal';
};

const VirtualizedTextViewer: React.FC<{ text: string; mode: 'diff' | 'code' }> = ({ text, mode }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  // Measure the scroll container so the virtualized window fills the available
  // panel height instead of a hard-coded value.
  const [viewportHeight, setViewportHeight] = useState(REVIEW_MIN_VIEWPORT_HEIGHT);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(Math.max(el.clientHeight, REVIEW_MIN_VIEWPORT_HEIGHT));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => text.split('\n'), [text]);
  const visibleCount = Math.ceil(viewportHeight / REVIEW_LINE_HEIGHT) + REVIEW_OVERSCAN_LINES * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / REVIEW_LINE_HEIGHT) - REVIEW_OVERSCAN_LINES);
  const endIndex = Math.min(lines.length, startIndex + visibleCount);
  const visibleLines = lines.slice(startIndex, endIndex);
  const totalHeight = Math.max(lines.length * REVIEW_LINE_HEIGHT, viewportHeight);

  return (
    <div
      ref={scrollRef}
      className={mode === 'code' ? 'diff-code-viewer-body' : 'diff-text'}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      style={{
        height: '100%',
        minHeight: `${REVIEW_MIN_VIEWPORT_HEIGHT}px`,
        overflow: 'auto',
        background: mode === 'code' ? 'var(--bg-card)' : undefined,
        border: mode === 'code' ? '1px solid var(--border)' : undefined,
        borderRadius: mode === 'code' ? '4px' : undefined,
      }}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${startIndex * REVIEW_LINE_HEIGHT}px)` }}>
          {visibleLines.map((line, offset) => {
            const lineNumber = startIndex + offset + 1;
            const className = mode === 'diff' ? getDiffLineClass(line) : 'code-line';

            return (
              <div
                key={lineNumber}
                className={className}
                style={{
                  minHeight: REVIEW_LINE_HEIGHT,
                  lineHeight: `${REVIEW_LINE_HEIGHT}px`,
                  display: 'flex',
                  fontFamily: 'monospace',
                  fontSize: '12px',
                  color: mode === 'code' ? 'var(--text-primary)' : undefined,
                  whiteSpace: 'pre',
                }}
              >
                {mode === 'code' && (
                  <span
                    style={{
                      color: 'var(--text-muted)',
                      borderRight: '1px solid var(--border)',
                      display: 'inline-block',
                      marginRight: '12px',
                      minWidth: '40px',
                      paddingRight: '8px',
                      textAlign: 'right',
                      userSelect: 'none',
                    }}
                  >
                    {lineNumber}
                  </span>
                )}
                <span>{line || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
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
    commitStaged
  } = useReviewStore();

  const [activeTab, setActiveTab] = useState<'diff' | 'test'>('diff');
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  
  const [diffSubTab, setDiffSubTab] = useState<'diff' | 'code'>('diff');
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

  // Detect default test command based on language configs
  useEffect(() => {
    if (activeRecord) {
      const hasCargo = activeRecord.changedFiles.some(f => f.path.endsWith('.rs') || f.path === 'Cargo.toml');
      const hasPy = activeRecord.changedFiles.some(f => f.path.endsWith('.py') || f.path === 'requirements.txt');
      if (hasCargo) {
        setVerificationCmd('cargo test');
      } else if (hasPy) {
        setVerificationCmd('pytest');
      } else {
        setVerificationCmd('npm test');
      }
    }
  }, [activeRecord]);

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
    } catch (err: any) {
      useNotificationStore.getState().error(`Approval failed: ${err.toString()}`);
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
    } catch (err: any) {
      useNotificationStore.getState().error(`Rejection failed: ${err.toString()}`);
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
    } catch (err: any) {
      useNotificationStore.getState().error(`Refresh failed: ${err.toString()}`);
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
    } catch (err: any) {
      useNotificationStore.getState().error(`Failed to save memory note: ${err.toString()}`);
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

  return (
    <section className="review-room review-room-container">
      <div className="room-header">
        <div>
          <p className="eyebrow">Human review gate</p>
          <h2>Review Room</h2>
          <p>Inspect changed files, run test verifications, add feedback, and approve/reject agent outputs.</p>
        </div>
        <button className="secondary-action" onClick={() => setActiveView('kanban')}>
          <RotateCcw size={16} />
          Kanban Tasks
        </button>
      </div>

      <div className="review-layout">
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
                      <span className="eyebrow" style={{ marginTop: '4px', fontSize: '9px' }}>
                        {record.changedFiles.length} files changed
                      </span>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>

        {/* Center Column: Diff & Verification Output */}
        <section className="surface review-main review-detail-panel">
          {!activeTaskId ? (
            <div className="room-empty-state" style={{ height: '100%', justifyContent: 'center' }}>
              <CheckCircle2 size={24} />
              <h3>Select a task from the review queue</h3>
            </div>
          ) : reviewLoading && !activeRecord ? (
            <div className="compact-empty">Loading review record...</div>
          ) : (
            <>
              <div className="review-detail-header">
                <div>
                  <h3 style={{ margin: 0, fontSize: '16px' }}>{activeTask?.title}</h3>
                  <span
                    className={`status-pill ${statusPillClass(activeRecord?.status)}`}
                    style={{ textTransform: 'capitalize' }}
                  >
                    Status: {activeRecord?.status ?? 'pending'}
                  </span>
                </div>
                <button
                  className="secondary-action"
                  onClick={handleRefresh}
                  disabled={refreshing || reviewLoading}
                  title="Re-pull git status & diffs"
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
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
                  <div className="file-list-container">
                    {activeRecord?.changedFiles.length === 0 ? (
                      <div className="compact-empty" style={{ padding: '12px' }}>No files changed.</div>
                    ) : (
                      activeRecord?.changedFiles.map((file) => {
                        const fileClass = file.path === selectedFile ? 'active' : '';
                        return (
                          <div
                            key={file.path}
                            className={`file-item ${fileClass}`}
                            onClick={() => setSelectedFile(file.path)}
                          >
                            <input
                              type="checkbox"
                              className="file-stage-checkbox"
                              checked={!!file.staged}
                              onClick={(e) => e.stopPropagation()}
                              onChange={() => handleToggleStaged(file.path, !file.staged)}
                              title={file.staged ? 'Unstage file' : 'Stage file for commit'}
                              aria-label={`Stage ${file.path} for commit`}
                            />
                            <span className="file-path" title={file.path}>{file.path}</span>
                            <div className="file-badges">
                              <span className="eyebrow" style={{ fontSize: '10px' }}>{file.status}</span>
                              {file.insertions !== undefined && (
                                <span className="badge-ins">+{file.insertions}</span>
                              )}
                              {file.deletions !== undefined && (
                                <span className="badge-del">-{file.deletions}</span>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {(activeRecord?.changedFiles.length ?? 0) > 0 && (
                    <div className="review-commit-bar">
                      <input
                        className="review-commit-input"
                        value={commitMessage}
                        placeholder={stagedCount > 0 ? 'Commit message (e.g. "fix: ...")' : 'Stage files above to commit'}
                        spellCheck={false}
                        onChange={(e) => setCommitMessage(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleCommit();
                          }
                        }}
                      />
                      <button
                        className="review-commit-btn"
                        disabled={committing || stagedCount === 0 || !commitMessage.trim()}
                        onClick={() => void handleCommit()}
                        title="git commit the staged files"
                      >
                        <Check size={13} />
                        <span>{committing ? 'Committing...' : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ''}`}</span>
                      </button>
                    </div>
                  )}

                  {unrelatedFiles.length > 0 && (
                    <div className="warning-banner">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 'bold' }}>
                        <AlertTriangle size={14} />
                        <span>Warning: Unrelated Files Modified</span>
                      </div>
                      <span>
                        The agent modified files outside the target file list:
                        <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                          {unrelatedFiles.slice(0, 3).map(f => (
                            <li key={f.path} style={{ fontFamily: 'monospace', fontSize: '11px' }}>{f.path}</li>
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
                        className={`diff-subtab-btn ${diffSubTab === 'code' ? 'active' : ''}`}
                        onClick={() => setDiffSubTab('code')}
                      >
                        Full File Code
                      </button>
                    </div>
                  )}

                  <div className="diff-viewer">
                    {diffSubTab === 'diff' ? (
                      loadingDiff ? (
                        <div className="compact-empty">Loading unified diff...</div>
                      ) : !selectedFile ? (
                        <div className="compact-empty">Select a file to inspect its diff.</div>
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
                  <div className="verification-input-row">
                    <input 
                      type="text" 
                      value={verificationCmd} 
                      onChange={(e) => setVerificationCmd(e.target.value)} 
                      placeholder="e.g. npm test, cargo check" 
                      disabled={runningVerification}
                    />
                    <button 
                      className="primary" 
                      onClick={handleRunVerification}
                      disabled={runningVerification || submittingDecision}
                      style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px' }}
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

        {/* Right Column: Actions & Handoff Info */}
        <section className="surface review-side">
          <div className="panel-heading">
            <Terminal size={16} />
            <span>Actions & Context</span>
          </div>

          {activeTask ? (
            <div className="side-panel-content">
              <div>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Task Brief</h4>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-secondary)' }}>
                  {activeTask.description || 'No description provided.'}
                </p>
              </div>

              {activeTask.targetFiles && activeTask.targetFiles.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Expected Target Files</h4>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {activeTask.targetFiles.map(f => (
                      <span key={f} className="status-pill command" style={{ fontSize: '10px', fontFamily: 'monospace' }}>
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {activeTask.acceptanceCriteria && activeTask.acceptanceCriteria.length > 0 && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Acceptance Checklist</h4>
                  <div className="review-criteria-list">
                    {activeTask.acceptanceCriteria.map((c, i) => (
                      <div key={i} className="review-criteria-item">
                        <CheckCircle2 size={13} aria-hidden className="criteria-marker" />
                        <span>{c}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeRecord && (
                <div>
                  <h4 style={{ margin: '0 0 6px 0', fontSize: '13px' }}>Agent Metadata</h4>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    <div><strong>Provider:</strong> {activeRecord.provider}</div>
                    <div><strong>Model:</strong> {activeRecord.model}</div>
                    <div><strong>Role:</strong> {activeRecord.role}</div>
                  </div>
                </div>
              )}

              {/* Actions Section */}
              {activeRecord && activeRecord.status === 'pending' && (
                <div className="review-action-buttons review-side-footer">
                  {rejecting && (
                    <div className="rejection-notes-box">
                      <span className="eyebrow" style={{ fontSize: '10px', color: 'var(--color-danger)' }}>Rejection Feedback</span>
                      <textarea 
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Explain what needs to be fixed. The agent will read these notes..."
                        disabled={submittingDecision}
                      />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button 
                      className={`danger ${rejecting ? 'primary' : ''}`}
                      onClick={handleReject}
                      disabled={submittingDecision || runningVerification}
                      style={{ flex: 1, padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                    >
                      <XCircle size={14} />
                      <span>{rejecting ? 'Submit Rejection' : 'Reject'}</span>
                    </button>
                    {!rejecting && (
                      <button 
                        className="primary"
                        onClick={handleApprove}
                        disabled={submittingDecision || runningVerification}
                        style={{ flex: 1, padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                      >
                        <Check size={14} />
                        <span>Approve</span>
                      </button>
                    )}
                  </div>
                  
                  {rejecting && (
                    <button 
                      className="secondary-action" 
                      onClick={() => { setRejecting(false); setNotes(''); }}
                      disabled={submittingDecision}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}

              {activeRecord && activeRecord.status !== 'pending' && (
                <div className="review-side-footer" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
                    {activeRecord.status === 'approved' ? (
                      <>
                        <Award className="success-icon" size={16} />
                        <span style={{ fontWeight: 'bold' }}>Review Approved</span>
                      </>
                    ) : (
                      <>
                        <ShieldAlert className="warning-icon" size={16} />
                        <span style={{ fontWeight: 'bold' }}>Review Rejected</span>
                      </>
                    )}
                  </div>
                  {activeRecord.notes && (
                    <div style={{ background: 'var(--bg-card)', padding: '10px', borderRadius: '4px', fontSize: '12px', border: '1px solid var(--border)' }}>
                      <strong>Rejection Notes:</strong>
                      <p style={{ margin: '4px 0 0 0', whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>{activeRecord.notes}</p>
                    </div>
                  )}

                  {/* Create Memory Note */}
                  <button 
                    className="secondary-action" 
                    onClick={handleCreateMemory}
                    disabled={memoryCreated}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', justifyContent: 'center', padding: '8px' }}
                  >
                    <FileText size={14} />
                    <span>{memoryCreated ? 'Memory Created' : 'Create Memory Note'}</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="compact-empty">Select a task to review context.</div>
          )}
        </section>
      </div>
    </section>
  );
};
