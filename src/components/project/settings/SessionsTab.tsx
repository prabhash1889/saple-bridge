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
          <div className="extracted-style-073">
            {sessions.map((session) => {
              const duration = session.completedAt
                ? Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 1000)
                : null;

              return (
                <div
                  key={session.id} className="extracted-style-074"
                >
                  <div className="extracted-style-075">
                    <div>
                      <strong className="extracted-style-076">
                        {session.name}
                      </strong>
                      <span className="extracted-style-077">
                        ({session.id})
                      </span>
                    </div>
                    <span className={`status-pill ${session.status === 'running' || session.status === 'starting' ? 'command' : session.status === 'done' ? 'success' : 'warning'}`}>
                      {session.status.toUpperCase()}
                    </span>
                  </div>

                  <div className="extracted-style-078">
                    <div>
                      <strong>Provider:</strong> <span className="extracted-style-079">{session.provider} ({session.model})</span>
                    </div>
                    <div>
                      <strong>Role:</strong> <span>{session.role}</span>
                    </div>
                    <div>
                      <strong>Duration:</strong> <span>{duration !== null ? `${duration}s` : 'Active / Running'}</span>
                    </div>
                  </div>

                  <div className="extracted-style-080">
                    <span>Started: {new Date(session.startedAt).toLocaleString()}</span>
                    <div className="extracted-style-081">
                      <button
                        className="extracted-style-082 secondary btn-sm"
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
                          className="extracted-style-083 secondary btn-sm"
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
            className="extracted-style-084 modal-container"
            onClick={e => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="confirm-header">
              <h3 className="extracted-style-085">Session Log: {activeLogTitle}</h3>
              <button className="confirm-close-x" onClick={() => setActiveLogContent(null)} aria-label="Close logs"><X size={16} /></button>
            </div>
            <div className="extracted-style-086">
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
