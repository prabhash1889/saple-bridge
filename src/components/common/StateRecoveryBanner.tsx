import React from 'react';
import { RotateCw, FolderOpen, ArchiveRestore, Eraser, FileWarning, AlertTriangle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useConfirmStore } from '../../stores/confirmStore';
import { resolveStateCorruption, type CorruptState } from '../../lib/stateLoad';

interface StateRecoveryBannerProps {
  projectPath: string;
  corrupt: CorruptState;
  /** Human name of the affected store, e.g. "Kanban tasks" or "Swarm state". */
  label: string;
  /** Called after a recovery action succeeded so the store can reload fresh state. */
  onRecovered: () => void;
}

/**
 * Recovery UI for a corrupt persisted state file (Improvement Plan Phase 2).
 *
 * Shows the affected path and the parse error, and offers the recovery actions: retry,
 * reveal the file, restore the preserved corrupt copy, or explicitly start empty.
 * Writes to the affected store stay blocked until one of these resolves.
 */
export const StateRecoveryBanner: React.FC<StateRecoveryBannerProps> = ({
  projectPath,
  corrupt,
  label,
  onRecovered,
}) => {
  const confirm = useConfirmStore((s) => s.confirm);
  const [busy, setBusy] = React.useState<string | null>(null);

  const runAction = async (action: 'retry' | 'restore_backup' | 'start_empty') => {
    setBusy(action);
    try {
      const result = await resolveStateCorruption(projectPath, corrupt.filePath, action);
      if (result.status === 'corrupt' || result.status === 'locked') {
        // Still broken (or still held) - reload so the store re-flags and the banner stays.
        onRecovered();
      } else {
        onRecovered();
      }
    } finally {
      setBusy(null);
    }
  };

  const reveal = () => {
    // The backup copy sits next to the original inside .saple/, so revealing the workspace
    // root opens the right neighborhood in either file explorer.
    void invoke('reveal_in_file_explorer', { projectPath, filePath: '' }).catch(() => {});
  };

  const startEmpty = () =>
    confirm({
      title: `Start ${label} empty?`,
      message:
        `The corrupted file's contents will be replaced by fresh empty state the next time you save. ` +
        `The preserved copy of the corrupted bytes stays on disk next to the original.`,
      confirmLabel: 'Start empty',
      onConfirm: () => void runAction('start_empty'),
    });

  return (
    <div role="alert" className="state-recovery-banner">
      <div className="state-recovery-header">
        <FileWarning className="h-5 w-5" aria-hidden style={{ color: 'var(--color-warning)' }} />
        <div>
          <p className="font-semibold">{label} file is corrupted</p>
          <p className="state-recovery-path"><code>{corrupt.filePath}</code></p>
          <p className="state-recovery-error">{corrupt.error}</p>
          <p className="state-recovery-hint">
            The original bytes were preserved at{' '}
            <button type="button" className="text-btn state-reveal-btn" onClick={reveal}>
              {corrupt.backupPath}
            </button>
            . Writes are blocked until you pick a recovery option.
          </p>
        </div>
      </div>

      <div className="state-recovery-actions">
        <button type="button" disabled={busy !== null} onClick={() => void runAction('retry')}>
          <RotateCw aria-hidden /> Retry
        </button>
        <button type="button" disabled={busy !== null} onClick={reveal}>
          <FolderOpen aria-hidden /> Reveal file
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void runAction('restore_backup')}>
          <ArchiveRestore aria-hidden /> Restore backup
        </button>
        <button type="button" disabled={busy !== null} onClick={startEmpty}>
          <Eraser aria-hidden /> Start empty
        </button>
      </div>

      <p className="state-recovery-note">
        <AlertTriangle aria-hidden /> Edits to {label.toLowerCase()} stay blocked until recovery completes.
      </p>
    </div>
  );
};
