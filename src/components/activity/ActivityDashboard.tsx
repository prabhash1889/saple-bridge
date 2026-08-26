import React, { useEffect, useMemo, useState } from 'react';
import { Activity as ActivityIcon, Bot, FileText } from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { sessionToRow, type ActivityOutcome, type ActivityRow } from './activityRows';

const OUTCOME_LABELS: Record<ActivityOutcome, string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const OutcomePill: React.FC<{ outcome: ActivityOutcome }> = ({ outcome }) => (
  <span className={`activity-outcome activity-outcome-${outcome}`}>
    {OUTCOME_LABELS[outcome]}
  </span>
);

export const ActivityDashboard: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const sessions = useAgentSessionStore((state) => state.sessions);
  const loaded = useAgentSessionStore((state) => state.loaded);
  const loadSessions = useAgentSessionStore((state) => state.loadSessions);

  useEffect(() => {
    if (!currentProjectPath) return;
    void loadSessions(currentProjectPath);
  }, [currentProjectPath, loadSessions]);

  // Running rows show a live duration; a 1s tick keeps them current. This is a light
  // view (unmounts when hidden), so no visibility gating is needed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const rows = useMemo(
    () =>
      sessions
        .map((session) => sessionToRow(session, now))
        .sort((a, b) => (a.id < b.id ? 1 : -1)),
    [sessions, now],
  );

  if (!currentProjectPath) {
    return (
      <div className="activity-empty">
        <Bot size={54} className="activity-empty-icon" />
        <h3>Agent Activity</h3>
        <p>Open a workspace to see agent and run history.</p>
      </div>
    );
  }

  if (loaded && rows.length === 0) {
    return (
      <div className="activity-empty">
        <ActivityIcon size={54} className="activity-empty-icon" />
        <h3>No agent activity yet</h3>
        <p>Launch an agent from the Command Room or the Swarm Room and its runs will appear here.</p>
      </div>
    );
  }

  return (
    <div className="activity-view">
      <div className="activity-header">
        <h2>Agent Activity</h2>
        <span className="activity-count">
          {rows.length} {rows.length === 1 ? 'session' : 'sessions'}
        </span>
      </div>
      <div className="activity-table" role="table" aria-label="Agent sessions">
        <div className="activity-row activity-row-head" role="row">
          <span role="columnheader">Agent</span>
          <span role="columnheader">Provider / Model</span>
          <span role="columnheader">Duration</span>
          <span role="columnheader">Outcome</span>
          <span role="columnheader">Transcript</span>
        </div>
        {rows.map((row: ActivityRow) => (
          <div key={row.id} className="activity-row" role="row">
            <span className="activity-name" role="cell">
              {row.name}
              <span className="activity-role">{row.role}</span>
            </span>
            <span className="activity-provider" role="cell">{row.providerModel}</span>
            <span className="activity-duration" role="cell">{row.duration || '-'}</span>
            <span role="cell"><OutcomePill outcome={row.outcome} /></span>
            <span className="activity-transcript" role="cell">
              {row.transcriptPath ? (
                <>
                  <FileText size={12} />
                  <code title={row.transcriptPath}>{row.transcriptPath}</code>
                </>
              ) : (
                '-'
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
