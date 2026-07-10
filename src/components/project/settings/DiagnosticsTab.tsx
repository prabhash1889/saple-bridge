import React, { useState } from 'react';
import { CheckCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useNotificationStore } from '../../../stores/notificationStore';
import { UpdatesSection } from './UpdatesSection';

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
    <>
    <UpdatesSection />
    <section className="surface">
      <div className="section-header">
        <ShieldCheck size={18} className="section-icon" />
        <span className="section-title">System Diagnostics</span>
      </div>
      <p className="section-desc">
        Run manual diagnostics checks on your system environment, shells, Git configuration, and OS Keychain integration.
      </p>

      <div className="settings-header-row">
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
        <div className="settings-list-col diag-list">
          <div className="settings-info-row diag-row">
            <span>Operating System</span>
            <strong>{diagResult.os}</strong>
          </div>
          <div className="settings-info-row diag-row">
            <span>Default Shell Environment</span>
            <strong>{diagResult.shell}</strong>
          </div>
          <div className="settings-info-row diag-row">
            <span>Workspace Write Permission</span>
            <span className={[diagResult.workspaceWrite ? 'status-ok' : 'status-error', 'settings-inline-row'].filter(Boolean).join(' ')}>
              {diagResult.workspaceWrite ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.workspaceWrite ? 'Granted' : 'Denied / Error'}</span>
            </span>
          </div>
          <div className="settings-info-row diag-row">
            <span>Git Status Check</span>
            <span className={[diagResult.gitAvailable ? 'status-ok' : 'status-error', 'settings-inline-row'].filter(Boolean).join(' ')}>
              {diagResult.gitAvailable ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.gitAvailable ? 'Available' : 'Failed / Not in repository'}</span>
            </span>
          </div>

          <div className="settings-block-gap">
            <h4 className="settings-subheading">
              OS Keychain Backend
            </h4>
            <p className="settings-tight-heading section-desc">
              A single probe of the OS credential store. This reflects the keychain backend's
              availability — not whether any individual provider key is saved. For per-provider
              key presence, see the &quot;Key saved&quot; badge on each Providers card.
            </p>
            <div className="settings-detail-list">
              {(() => {
                const status: string = diagResult.keychains?.[0]?.status ?? 'unknown';
                const ok = status === 'ok';
                return (
                  <div className="settings-detail-row diag-row">
                    <span>Keychain backend</span>
                    <span className={[ok ? 'status-ok' : 'status-error', 'settings-inline-row'].filter(Boolean).join(' ')}>
                      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{ok ? 'Ready' : `Error: ${status}`}</span>
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>

          <div className="settings-block-gap">
            <h4 className="settings-subheading">
              Provider CLI Availability
            </h4>
            <div className="settings-detail-list">
              {diagResult.providerClis.map((c) => (
                <div key={c.name} className="settings-detail-row diag-row">
                  <span className="settings-capitalize">{c.name} CLI</span>
                  <div className="settings-inline-8">
                    <span className={[c.available ? 'status-ok' : 'status-error', 'settings-inline-row'].filter(Boolean).join(' ')}>
                      {c.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{c.available ? 'Installed' : 'Missing'}</span>
                    </span>
                    {c.version && <span className="settings-mono-muted">({c.version})</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="settings-block-gap">
            <h4 className="settings-subheading">
              MCP Model Context Protocol Config
            </h4>
            <div className="settings-detail-list">
              <div className="settings-detail-row-plain diag-row">
                <span>Has .mcp.json file</span>
                <span>{diagResult.mcpConfig.hasMcpJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="settings-detail-row-plain diag-row">
                <span>Has mcp_config.json file</span>
                <span>{diagResult.mcpConfig.hasMcpConfigJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="settings-detail-row-plain diag-row">
                <span>saple-memory tool configured</span>
                <span className={diagResult.mcpConfig.sapleMemoryConfigured ? 'status-ok' : 'status-error'}>
                  {diagResult.mcpConfig.sapleMemoryConfigured ? 'Active' : 'Config Missing'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : diagError ? (
        <div className="settings-bordered-box status-error">
          Diagnostics error: {diagError}
        </div>
      ) : (
        <div className="settings-section-pad compact-empty">
          {!currentProjectPath ? 'Open a workspace first.' : 'No diagnostics data. Run check above.'}
        </div>
      )}
    </section>
    </>
  );
};
