import React, { useState } from 'react';
import { CheckCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useNotificationStore } from '../../../stores/notificationStore';

// Shape of the `run_diagnostics` Rust command result, limited to the fields this tab reads.
interface DiagnosticsResult {
  os: string;
  shell: string;
  workspaceWrite: boolean;
  gitAvailable: boolean;
  keychains?: Array<{ status: string }>;
  providerClis: Array<{ name: string; available: boolean; version?: string }>;
  mcpConfig: {
    hasMcpJson: boolean;
    hasMcpConfigJson: boolean;
    sapleMemoryConfigured: boolean;
  };
}

export const DiagnosticsTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);

  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<DiagnosticsResult | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const successNotification = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const errorNotification = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  return (
    <section className="surface">
      <div className="section-header">
        <ShieldCheck size={18} className="section-icon" />
        <span className="section-title">System Diagnostics</span>
      </div>
      <p className="section-desc">
        Run manual diagnostics checks on your system environment, shells, Git configuration, and OS Keychain integration.
      </p>

      <div className="extracted-style-026">
        <button
          onClick={async () => {
            if (!currentProjectPath) return;
            setDiagLoading(true);
            setDiagResult(null);
            setDiagError(null);
            try {
              const res = await invoke<DiagnosticsResult>('run_diagnostics', { projectPath: currentProjectPath });
              setDiagResult(res);
              successNotification('Diagnostics completed successfully.');
            } catch (err) {
              setDiagError(String(err));
              errorNotification(`Diagnostics failed: ${String(err)}`);
            } finally {
              setDiagLoading(false);
            }
          }}
          disabled={diagLoading || !currentProjectPath}
          className="primary"
        >
          <RefreshCw size={14} className={diagLoading ? 'spin' : ''} />
          <span>{diagLoading ? 'Running Diagnostics...' : 'Run Diagnostics'}</span>
        </button>
      </div>

      {diagResult ? (
        <div className="extracted-style-027 diag-list">
          <div className="extracted-style-028 diag-row">
            <span>Operating System</span>
            <strong>{diagResult.os}</strong>
          </div>
          <div className="extracted-style-029 diag-row">
            <span>Default Shell Environment</span>
            <strong>{diagResult.shell}</strong>
          </div>
          <div className="extracted-style-030 diag-row">
            <span>Workspace Write Permission</span>
            <span className={[diagResult.workspaceWrite ? 'status-ok' : 'status-error', 'extracted-style-278'].filter(Boolean).join(' ')}>
              {diagResult.workspaceWrite ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.workspaceWrite ? 'Granted' : 'Denied / Error'}</span>
            </span>
          </div>
          <div className="extracted-style-031 diag-row">
            <span>Git Status Check</span>
            <span className={[diagResult.gitAvailable ? 'status-ok' : 'status-error', 'extracted-style-279'].filter(Boolean).join(' ')}>
              {diagResult.gitAvailable ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.gitAvailable ? 'Available' : 'Failed / Not in repository'}</span>
            </span>
          </div>

          <div className="extracted-style-032">
            <h4 className="extracted-style-033">
              OS Keychain Backend
            </h4>
            <p className="extracted-style-034 section-desc">
              A single probe of the OS credential store. This reflects the keychain backend's
              availability — not whether any individual provider key is saved. For per-provider
              key presence, see the &quot;Key saved&quot; badge on each Providers card.
            </p>
            <div className="extracted-style-035">
              {(() => {
                const status: string = diagResult.keychains?.[0]?.status ?? 'unknown';
                const ok = status === 'ok';
                return (
                  <div className="extracted-style-036 diag-row">
                    <span>Keychain backend</span>
                    <span className={[ok ? 'status-ok' : 'status-error', 'extracted-style-280'].filter(Boolean).join(' ')}>
                      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{ok ? 'Ready' : `Error: ${status}`}</span>
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="extracted-style-037">
            <h4 className="extracted-style-038">
              Provider CLI Availability
            </h4>
            <div className="extracted-style-039">
              {diagResult.providerClis.map((c) => (
                <div key={c.name} className="extracted-style-040 diag-row">
                  <span className="extracted-style-041">{c.name} CLI</span>
                  <div className="extracted-style-042">
                    <span className={[c.available ? 'status-ok' : 'status-error', 'extracted-style-281'].filter(Boolean).join(' ')}>
                      {c.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{c.available ? 'Installed' : 'Missing'}</span>
                    </span>
                    {c.version && <span className="extracted-style-043">({c.version})</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="extracted-style-044">
            <h4 className="extracted-style-045">
              MCP Model Context Protocol Config
            </h4>
            <div className="extracted-style-046">
              <div className="extracted-style-047 diag-row">
                <span>Has .mcp.json file</span>
                <span>{diagResult.mcpConfig.hasMcpJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="extracted-style-048 diag-row">
                <span>Has mcp_config.json file</span>
                <span>{diagResult.mcpConfig.hasMcpConfigJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="extracted-style-049 diag-row">
                <span>saple-memory tool configured</span>
                <span className={diagResult.mcpConfig.sapleMemoryConfigured ? 'status-ok' : 'status-error'}>
                  {diagResult.mcpConfig.sapleMemoryConfigured ? 'Active' : 'Config Missing'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : diagError ? (
        <div className="extracted-style-050 status-error">
          Diagnostics error: {diagError}
        </div>
      ) : (
        <div className="extracted-style-051 compact-empty">
          {!currentProjectPath ? 'Open a workspace first.' : 'No diagnostics data. Run check above.'}
        </div>
      )}
    </section>
  );
};
