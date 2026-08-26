import React, { useCallback, useEffect, useState } from 'react';
import { CloudDownload, GitBranch, RefreshCw } from 'lucide-react';
import { useGitStore, type RemoteAction, type RemoteResult } from '../../stores/gitStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { describeSyncState, hasDiverged } from '../../lib/gitFormat';

const ACTION_LABEL: Record<RemoteAction, string> = {
  fetch: 'Fetch',
  pull: 'Pull',
  push: 'Push',
};

interface Props {
  projectPath: string;
}

// Slim remote-sync strip for the Review room header area (Phase 8.1): shows the
// current branch's ahead/behind state and triggers fetch/pull/push. Conflict
// resolution is deliberately deferred to a terminal; the banner says so.
export const GitSyncBar: React.FC<Props> = ({ projectPath }) => {
  const syncState = useGitStore((state) => state.syncState[projectPath]);
  const refreshSyncState = useGitStore((state) => state.refreshSyncState);
  const runRemote = useGitStore((state) => state.runRemote);

  const [busyAction, setBusyAction] = useState<RemoteAction | 'refresh' | null>(null);
  const [lastResult, setLastResult] = useState<RemoteResult | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    setLastResult(null);
    void refreshSyncState(projectPath).then((state) => setUnavailable(state === null));
  }, [projectPath, refreshSyncState]);

  const handleAction = useCallback(
    async (action: RemoteAction) => {
      setBusyAction(action);
      try {
        const result = await runRemote(projectPath, action);
        setLastResult(result);
        if (result.ok) {
          useNotificationStore.getState().success(`${ACTION_LABEL[action]} complete`, result.message);
        }
      } catch (err) {
        useNotificationStore.getState().error(`${ACTION_LABEL[action]} failed`, String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [projectPath, runRemote]
  );

  const handleRefresh = useCallback(async () => {
    setBusyAction('refresh');
    try {
      await refreshSyncState(projectPath);
    } finally {
      setBusyAction(null);
    }
  }, [projectPath, refreshSyncState]);

  // Non-git workspace or detached HEAD: nothing to sync.
  if (unavailable && !syncState) return null;

  const busy = busyAction !== null;
  const diverged = syncState ? hasDiverged(syncState) : false;

  return (
    <div className="git-sync-bar">
      <span className="git-sync-branch" title={syncState ? describeSyncState(syncState) : undefined}>
        <GitBranch size={14} />
        {syncState ? describeSyncState(syncState) : '...'}
      </span>

      <div className="git-sync-actions">
        <button
          className="secondary-action"
          onClick={() => void handleRefresh()}
          disabled={busy}
          title="Re-read branch sync state"
        >
          <RefreshCw size={14} className={busyAction === 'refresh' ? 'spinning' : undefined} />
        </button>
        {(['fetch', 'pull', 'push'] as RemoteAction[]).map((action) => (
          <button
            key={action}
            className={`secondary-action${action === 'push' ? ' git-sync-push' : ''}`}
            onClick={() => void handleAction(action)}
            disabled={busy}
            title={
              action === 'pull'
                ? 'Fast-forward only; divergent history must be resolved in a terminal'
                : `${ACTION_LABEL[action]} for ${syncState?.branch ?? 'the current branch'}`
            }
          >
            <CloudDownload size={14} />
            <span>{busyAction === action ? 'Working...' : ACTION_LABEL[action]}</span>
          </button>
        ))}
      </div>

      {(lastResult?.conflicts || (diverged && lastResult && !lastResult.ok)) && (
        <div className="warning-banner git-sync-conflict" role="alert">
          <strong>Manual resolution needed.</strong> Resolve in a terminal opened in this workspace,
          then retry. Details:
          <pre className="git-sync-message">{lastResult.message}</pre>
        </div>
      )}
      {!lastResult?.conflicts && lastResult && !lastResult.ok && (
        <div className="warning-banner git-sync-conflict" role="alert">
          <pre className="git-sync-message">{lastResult.message}</pre>
        </div>
      )}
    </div>
  );
};
