import React, { useEffect, useMemo } from 'react';
import { CheckCircle, Cpu, Database, GitPullRequest, PanelTop, ShieldAlert, ShieldCheck, XCircle, AlertCircle } from 'lucide-react';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useProviderStore } from '../../stores/providerStore';

const PROVIDER_READINESS_TTL_MS = 60_000;

export const StatusBar: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const paneCount = useTerminalStore((state) => state.panes.length);
  const reviewTasks = useKanbanStore((state) => state.tasks.filter((task) => task.column === 'review').length);
  const memoryCount = useMemoryStore((state) => state.nodes.length);
  const runningAgents = useSwarmStore((state) =>
    state.activeAgents.filter((agent) => ['running', 'waiting', 'review'].includes(agent.status)).length
  );
  const providers = useProviderStore((state) => state.providers);
  const refreshReadiness = useProviderStore((state) => state.refreshReadiness);

  const readinessInfo = useMemo(() => {
    const enabled = providers.filter(p => p.enabled && p.provider !== 'custom');
    const ready = enabled.filter(p => p.authenticated === true);
    const authNeeded = enabled.filter(p => p.authenticated === false);
    const unknown = enabled.filter(p => p.authenticated === null);
    return { ready: ready.length, authNeeded: authNeeded.length, unknown: unknown.length, total: enabled.length };
  }, [providers]);

  useEffect(() => {
    if (!currentProjectPath) return;

    const lastCheckedAt = providers
      .map((provider) => provider.checkedAt ? Date.parse(provider.checkedAt) : 0)
      .filter((timestamp) => Number.isFinite(timestamp))
      .sort((a, b) => b - a)[0] || 0;
    const hasFreshCheck = Date.now() - lastCheckedAt < PROVIDER_READINESS_TTL_MS;
    if (hasFreshCheck) return;

    const run = () => {
      void refreshReadiness();
    };

    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(run, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }

    const id = globalThis.setTimeout(run, 1500);
    return () => globalThis.clearTimeout(id);
  }, [currentProjectPath, providers, refreshReadiness]);

  const readinessPill = () => {
    if (!currentProjectPath) return <span className="status-pill">No workspace</span>;
    if (readinessInfo.unknown === readinessInfo.total) return <span className="status-pill warning">Provider checks pending</span>;
    if (readinessInfo.authNeeded > 0) return <span className="status-pill warning"><AlertCircle size={11} /> {readinessInfo.authNeeded} auth needed</span>;
    if (readinessInfo.ready > 0) return <span className="status-pill command"><CheckCircle size={11} /> {readinessInfo.ready}/{readinessInfo.total} ready</span>;
    return <span className="status-pill"><XCircle size={11} /> No providers ready</span>;
  };

  return (
    <footer className="statusbar-area">
      <div className="statusbar-section">
        {currentProjectPath ? <ShieldCheck size={13} className="success-icon" /> : <ShieldAlert size={13} className="warning-icon" />}
        <span>{currentProjectPath ? 'Workspace ready' : 'No workspace path'}</span>
      </div>

      <div className="statusbar-section statusbar-counts">
        <span><PanelTop size={12} /> {paneCount} panes</span>
        <span><Cpu size={12} /> {runningAgents} active agents</span>
        <span><Database size={12} /> {memoryCount} memories</span>
        <span><GitPullRequest size={12} /> {reviewTasks} in review</span>
      </div>

      <div className="statusbar-section provider-readiness">
        {readinessPill()}
      </div>
    </footer>
  );
};
