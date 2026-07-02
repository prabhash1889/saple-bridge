import React, { useState, useEffect } from 'react';
import { Database, RefreshCw } from 'lucide-react';
import { useProjectStore } from '../../../stores/projectStore';
import { useMemoryStore } from '../../../stores/memoryStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useConfirmStore } from '../../../stores/confirmStore';

export const MemoryTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const { snapshots, loadSnapshots, takeSnapshot, restoreSnapshot } = useMemoryStore();
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  const confirmAction = (opts: any) => useConfirmStore.getState().confirm(opts);
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!snapshotName.trim()) return;
              setSnapshotLoading(true);
              try {
                await takeSnapshot(currentProjectPath, snapshotName.trim());
                setSnapshotName('');
                successNotification('Snapshot created successfully!');
              } catch (err: any) {
                errorNotification(`Failed to create snapshot: ${err.toString()}`);
              } finally {
                setSnapshotLoading(false);
              }
            }}
            style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}
          >
            <div className="input-group" style={{ flex: 1, margin: 0 }}>
              <label style={{ fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Snapshot Name
              </label>
              <input
                type="text"
                placeholder="e.g. before-refactoring"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
                disabled={snapshotLoading}
                style={{ height: '36px' }}
              />
            </div>
            <button type="submit" className="primary" disabled={snapshotLoading || !snapshotName.trim()} style={{ height: '36px' }}>
              <RefreshCw size={14} className={snapshotLoading ? 'spin' : ''} />
              <span>{snapshotLoading ? 'Taking Snapshot...' : 'Take Snapshot'}</span>
            </button>
          </form>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
            <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '12px' }}>
              Available Snapshots ({snapshots.length})
            </h4>

            {snapshots.length === 0 ? (
              <div className="compact-empty" style={{ padding: '20px' }}>No snapshots created yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {snapshots.map((name) => (
                  <div
                    key={name}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '10px 12px',
                      background: 'var(--bg-surface-light)',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-md)'
                    }}
                  >
                    <span style={{ fontSize: '13px', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
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
                            } catch (err: any) {
                              errorNotification(`Failed to restore snapshot: ${err.toString()}`);
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
