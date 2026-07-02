import React, { useState, useEffect } from 'react';
import { Clock, FileText, Play, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useAgentSessionStore } from '../../../stores/agentSessionStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { useTerminalStore } from '../../../stores/terminalStore';

export const SessionsTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const { sessions, loadSessions, setSessionStatus, saveSessions } = useAgentSessionStore();
  const [activeLogContent, setActiveLogContent] = useState<string | null>(null);
  const [activeLogTitle, setActiveLogTitle] = useState<string | null>(null);

  const successNotification = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const errorNotification = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  useEffect(() => {
    if (currentProjectPath) {
      loadSessions(currentProjectPath);
    }
  }, [currentProjectPath, loadSessions]);

  return (
    <>
      <section className="surface">
        <div className="section-header">
          <Clock size={18} className="section-icon" />
          <span className="section-title">Agent Session History</span>
        </div>
        <p className="section-desc">
          View and audit all past and active AI agent runs in this project workspace.
        </p>

        {!currentProjectPath ? (
          <div className="compact-empty">Open a workspace to view agent sessions.</div>
        ) : sessions.length === 0 ? (
          <div className="compact-empty">No agent sessions recorded in this project yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {sessions.map((session) => {
              const duration = session.completedAt
                ? Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)
                : null;

              return (
                <div
                  key={session.id}
                  style={{
                    padding: '12px',
                    background: 'var(--bg-surface-light)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <strong style={{ color: 'var(--text-primary)', fontSize: '13px' }}>
                        {session.name}
                      </strong>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginLeft: '10px' }}>
                        ({session.id})
                      </span>
                    </div>
                    <span className={`status-pill ${session.status === 'running' || session.status === 'starting' ? 'command' : session.status === 'done' ? 'success' : 'warning'}`}>
                      {session.status.toUpperCase()}
                    </span>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                    <div>
                      <strong>Provider:</strong> <span style={{ fontFamily: 'var(--font-mono)' }}>{session.provider} ({session.model})</span>
                    </div>
                    <div>
                      <strong>Role:</strong> <span>{session.role}</span>
                    </div>
                    <div>
                      <strong>Duration:</strong> <span>{duration !== null ? `${duration}s` : 'Active / Running'}</span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>
                    <span>Started: {new Date(session.startedAt).toLocaleString()}</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="secondary btn-sm"
                        style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 8px' }}
                        onClick={async () => {
                          try {
                            const content = await invoke<string>('read_project_file', {
                              projectPath: currentProjectPath,
                              filePath: session.outputLogPath
                            });
                            setActiveLogTitle(session.name);
                            setActiveLogContent(content);
                          } catch (err) {
                            errorNotification('Log file not found or empty.');
                          }
                        }}
                      >
                        <FileText size={11} />
                        <span>View Log</span>
                      </button>
                      {(session.status === 'stopped' || session.status === 'failed') && (
                        <button
                          className="secondary btn-sm"
                          style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 8px' }}
                          onClick={async () => {
                            try {
                              await useTerminalStore.getState().addPane(
                                currentProjectPath,
                                session.provider,
                                session.model,
                                session.promptPath
                              );
                              setSessionStatus(session.id, 'running');
                              await saveSessions(currentProjectPath);
                              successNotification('Agent session resumed in a new terminal.');
                              useProjectStore.getState().setActiveView('terminals');
                            } catch (err: any) {
                              errorNotification(`Failed to resume agent: ${err.toString()}`);
                            }
                          }}
                        >
                          <Play size={11} />
                          <span>Resume</span>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {activeLogContent !== null && (
        <div className="modal-overlay confirm-overlay" onClick={() => setActiveLogContent(null)}>
          <div
            className="modal-container"
            style={{ maxWidth: '800px', width: '95%', height: '80vh', display: 'flex', flexDirection: 'column' }}
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="confirm-header">
              <h3 style={{ margin: 0, fontSize: '15px' }}>Session Log: {activeLogTitle}</h3>
              <button className="confirm-close-x" onClick={() => setActiveLogContent(null)} aria-label="Close logs"><X size={16} /></button>
            </div>
            <div style={{ flex: 1, padding: '16px', background: 'var(--bg-deep)', color: 'var(--text-secondary)', overflow: 'auto', fontFamily: 'var(--font-mono)', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
              {activeLogContent || 'Log is empty.'}
            </div>
            <div className="confirm-footer">
              <button className="btn btn-secondary confirm-cancel-btn" onClick={() => setActiveLogContent(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
