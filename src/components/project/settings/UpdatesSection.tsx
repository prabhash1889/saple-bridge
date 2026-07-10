import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle, Download, RefreshCw } from 'lucide-react';
import { getVersion } from '@tauri-apps/api/app';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useNotificationStore } from '../../../stores/notificationStore';

// Idle -> checking -> (uptodate | available) -> downloading -> (relaunch) ; error from any step.
type UpdateStatus = 'idle' | 'checking' | 'uptodate' | 'available' | 'downloading' | 'error';

export const UpdatesSection: React.FC = () => {
  const [currentVersion, setCurrentVersion] = useState<string>('');
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [latestVersion, setLatestVersion] = useState<string>('');
  const [progress, setProgress] = useState<{ downloaded: number; total: number }>({ downloaded: 0, total: 0 });
  const [error, setError] = useState<string>('');
  // Hold the resolved Update so the install button can act on the same instance check() returned.
  const updateRef = useRef<Update | null>(null);

  const notify = useNotificationStore.getState;

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('unknown'));
  }, []);

  const checkForUpdates = async () => {
    setStatus('checking');
    setError('');
    try {
      const update = await check();
      if (update) {
        updateRef.current = update;
        setLatestVersion(update.version);
        setStatus('available');
      } else {
        setStatus('uptodate');
      }
    } catch (err) {
      // Local/dev builds have no updater feed configured, so this errors by design — surface it
      // plainly rather than pretending an update check ran.
      setError(String(err));
      setStatus('error');
    }
  };

  const downloadAndRestart = async () => {
    const update = updateRef.current;
    if (!update) return;
    setStatus('downloading');
    setProgress({ downloaded: 0, total: 0 });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            setProgress({ downloaded: 0, total });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setProgress({ downloaded, total });
            break;
          case 'Finished':
            setProgress({ downloaded: total, total });
            break;
        }
      });
      notify().success('Update installed. Restarting…');
      await relaunch();
    } catch (err) {
      setError(String(err));
      setStatus('error');
      notify().error(`Update failed: ${String(err)}`);
    }
  };

  const percent = progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : null;
  const busy = status === 'checking' || status === 'downloading';

  return (
    <section className="surface">
      <div className="section-header">
        <Download size={18} className="section-icon" />
        <span className="section-title">App Updates</span>
      </div>
      <p className="section-desc">
        Check for a newer signed release and install it in place. The app restarts into the new
        version after installing.
      </p>

      <div className="settings-info-row">
        <span>Current version</span>
        <strong>{currentVersion || '…'}</strong>
      </div>

      <div className="settings-header-row">
        {status === 'available' || status === 'downloading' ? (
          <button onClick={downloadAndRestart} disabled={busy} className="primary">
            <Download size={14} className={status === 'downloading' ? 'spin' : ''} />
            <span>
              {status === 'downloading'
                ? percent !== null
                  ? `Downloading… ${percent}%`
                  : 'Downloading…'
                : `Update to ${latestVersion} & Restart`}
            </span>
          </button>
        ) : (
          <button onClick={checkForUpdates} disabled={busy} className="primary">
            <RefreshCw size={14} className={status === 'checking' ? 'spin' : ''} />
            <span>{status === 'checking' ? 'Checking…' : 'Check for updates'}</span>
          </button>
        )}
      </div>

      {status === 'uptodate' && (
        <div className="settings-inline-row status-ok settings-section-pad">
          <CheckCircle size={14} />
          <span>You&apos;re on the latest version.</span>
        </div>
      )}

      {status === 'available' && (
        <div className="settings-inline-row status-ok settings-section-pad">
          <CheckCircle size={14} />
          <span>Version {latestVersion} is available.</span>
        </div>
      )}

      {status === 'error' && (
        <div className="settings-bordered-box status-error">Update check failed: {error}</div>
      )}
    </section>
  );
};
