import React, { useState, useEffect } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { useProjectStore } from '../../../stores/projectStore';
import { useMemoryStore } from '../../../stores/memoryStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useConfirmStore, type ConfirmOpts } from '../../../stores/confirmStore';

export const MemoryTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const { snapshots, loadSnapshots, takeSnapshot, restoreSnapshot } = useMemoryStore();
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  const confirmAction = (opts: ConfirmOpts) => useConfirmStore.getState().confirm(opts);
  const successNotification = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const errorNotification = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  useEffect(() => {
    if (currentProjectPath) {
      loadSnapshots(currentProjectPath);
    }
  }, [currentProjectPath, loadSnapshots]);

  return (
    <section className="surface">
      <div className="section-header">
        <Database size={18} className="section-icon" />
        <span className="section-title">Memory Graph Snapshots</span>
      </div>
      <p className="section-desc">
        Create and restore snapshots of your project memory graph. Snapshots back up note files under `.saple/memory` and their connections.
      </p>

      {!currentProjectPath ? (
        <div className="compact-empty">Open a workspace to manage memory snapshots.</div>
      ) : (
        <div className="extracted-style-060">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!snapshotName.trim()) return;
              setSnapshotLoading(true);
              try {
                await takeSnapshot(currentProjectPath, snapshotName.trim());
                setSnapshotName('');
                successNotification('Snapshot created successfully!');
              } catch (err) {
                errorNotification(`Failed to create snapshot: ${String(err)}`);
              } finally {
                setSnapshotLoading(false);
              }
            }} className="extracted-style-061"
          >
            <div className="extracted-style-062 input-group">
              <label className="extracted-style-063">
                Snapshot Name
              </label>
              <input
                type="text"
                placeholder="e.g. before-refactoring"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                disabled={snapshotLoading} className="extracted-style-064"
              />
            </div>
            <button type="submit" className="extracted-style-065 primary" disabled={snapshotLoading || !snapshotName.trim()}>
              <RefreshCw size={14} className={snapshotLoading ? 'spin' : ''} />
              <span>{snapshotLoading ? 'Taking Snapshot...' : 'Take Snapshot'}</span>
            </button>
          </form>

          <div className="extracted-style-066">
            <h4 className="extracted-style-067">
              Available Snapshots ({snapshots.length})
            </h4>

            {snapshots.length === 0 ? (
              <div className="extracted-style-068 compact-empty">No snapshots created yet.</div>
            ) : (
              <div className="extracted-style-069">
                {snapshots.map((name) => (
                  <div
                    key={name} className="extracted-style-070"
                  >
                    <span className="extracted-style-071">
                      {name}
                    </span>
                    <button
                      className="secondary btn-sm"
                      disabled={snapshotLoading}
                      onClick={() => {
                        confirmAction({
                          title: 'Restore Snapshot',
                          message: `Are you sure you want to restore snapshot "${name}"? This will overwrite your current memory graph.`,
                          onConfirm: async () => {
                            setSnapshotLoading(true);
                            try {
                              await restoreSnapshot(currentProjectPath, name);
                              successNotification('Snapshot restored successfully!');
                            } catch (err) {
                              errorNotification(`Failed to restore snapshot: ${String(err)}`);
                            } finally {
                              setSnapshotLoading(false);
                            }
                          }
                        });
                      }}
                    >
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
