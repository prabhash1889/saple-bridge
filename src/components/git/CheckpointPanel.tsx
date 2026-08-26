import React, { useCallback, useEffect, useState } from 'react';
import { History, Undo2, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfirmStore } from '../../stores/confirmStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useFileStore } from '../../stores/fileStore';
import type { Checkpoint } from '../../stores/gitStore';

interface Props {
  projectPath: string;
}

// Per-agent-run checkpoint list (Phase 8.2): hidden refs under
// refs/saple/checkpoints/<run-id>. Each row can show what changed since the
// checkpoint and restore the captured state on rejection/rework.
export const CheckpointPanel: React.FC<Props> = ({ projectPath }) => {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [diffText, setDiffText] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const loadCheckpoints = useCallback(async () => {
    try {
      // Newest first; a long agent history stays browsable.
      const list = await invoke<Checkpoint[]>('git_list_checkpoints', { projectPath });
      setCheckpoints(list.slice().reverse().slice(0, 10));
    } catch {
      setCheckpoints([]);
    }
  }, [projectPath]);

  useEffect(() => {
    setOpenId(null);
    setDiffText('');
    void loadCheckpoints();
  }, [projectPath, loadCheckpoints]);

  const toggleDiff = async (runId: string) => {
    if (openId === runId) {
      setOpenId(null);
      setDiffText('');
      return;
    }
    setOpenId(runId);
    setLoadingDiff(true);
    try {
      const diff = await invoke<string>('git_checkpoint_diff', { projectPath, runId });
      setDiffText(diff);
    } catch (err) {
      setDiffText(`Failed to load diff: ${String(err)}`);
    } finally {
      setLoadingDiff(false);
    }
  };

  const handleRestore = (checkpoint: Checkpoint) => {
    useConfirmStore.getState().confirm({
      title: 'Restore checkpoint',
      message:
        `Restore tracked files to the state captured before run "${checkpoint.id}"? ` +
        'Changes made since then are discarded from index and worktree. Files that were never staged survive.',
      confirmLabel: 'Restore',
      onConfirm: () => void performRestore(checkpoint),
    });
  };

  const performRestore = async (checkpoint: Checkpoint) => {
    setRestoringId(checkpoint.id);
    try {
      await invoke('git_restore_checkpoint', { projectPath, runId: checkpoint.id, confirmed: true });
      useNotificationStore.getState().success(
        `Restored checkpoint ${checkpoint.id}`,
        'Tracked files were rolled back to the pre-run state.'
      );
      await loadCheckpoints();
      await useFileStore.getState().loadGitStatus(projectPath).catch(() => {});
    } catch (err) {
      useNotificationStore.getState().error('Restore failed', String(err));
    } finally {
      setRestoringId(null);
    }
  };

  if (!checkpoints || checkpoints.length === 0) return null;

  return (
    <div className="checkpoint-panel">
      <div className="checkpoint-panel-heading">
        <History size={14} />
        <span>Agent run checkpoints</span>
      </div>
      <ul className="checkpoint-list">
        {checkpoints.map((cp) => (
          <li key={cp.id} className="checkpoint-item">
            <span className="checkpoint-id" title={`commit ${cp.commit}`}>{cp.id}</span>
            <div className="checkpoint-actions">
              <button
                className="diff-subtab-btn"
                onClick={() => void toggleDiff(cp.id)}
                disabled={restoringId !== null}
                title="Show changes made since this checkpoint"
              >
                {openId === cp.id ? <X size={12} /> : null}
                Diff
              </button>
              <button
                className="diff-subtab-btn"
                onClick={() => handleRestore(cp)}
                disabled={restoringId !== null}
                title="Roll tracked files back to this checkpoint"
              >
                <Undo2 size={12} />
                {restoringId === cp.id ? 'Restoring...' : 'Restore'}
              </button>
            </div>
            {openId === cp.id && (
              <pre className="checkpoint-diff">
                {loadingDiff ? 'Loading diff...' : diffText}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};
