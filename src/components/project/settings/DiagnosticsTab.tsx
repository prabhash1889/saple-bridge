import React, { useState } from 'react';
import { CheckCircle, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useNotificationStore } from '../../../stores/notificationStore';

export const DiagnosticsTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);

  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<any | null>(null);
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

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '20px' }}>
        <button
          onClick={async () => {
            if (!currentProjectPath) return;
            setDiagLoading(true);
            setDiagResult(null);
            setDiagError(null);
            try {
              const res = await invoke<any>('run_diagnostics', { projectPath: currentProjectPath });
              setDiagResult(res);
              successNotification('Diagnostics completed successfully.');
            } catch (err: any) {
              setDiagError(err.toString());
              errorNotification(`Diagnostics failed: ${err.toString()}`);
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
        <div className="diag-list" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <span>Operating System</span>
            <strong>{diagResult.os}</strong>
          </div>
          <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <span>Default Shell Environment</span>
            <strong>{diagResult.shell}</strong>
          </div>
          <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <span>Workspace Write Permission</span>
            <span className={diagResult.workspaceWrite ? 'status-ok' : 'status-error'} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {diagResult.workspaceWrite ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.workspaceWrite ? 'Granted' : 'Denied / Error'}</span>
            </span>
          </div>
          <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <span>Git Status Check</span>
            <span className={diagResult.gitAvailable ? 'status-ok' : 'status-error'} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              {diagResult.gitAvailable ? <CheckCircle size={14} /> : <XCircle size={14} />}
              <span>{diagResult.gitAvailable ? 'Available' : 'Failed / Not in repository'}</span>
            </span>
          </div>

          <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              OS Keychain Backend
            </h4>
            <p className="section-desc" style={{ marginTop: 0, marginBottom: '8px' }}>
              A single probe of the OS credential store. This reflects the keychain backend's
              availability — not whether any individual provider key is saved. For per-provider
              key presence, see the &quot;Key saved&quot; badge on each Providers card.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '8px' }}>
              {(() => {
                const status: string = diagResult.keychains?.[0]?.status ?? 'unknown';
                const ok = status === 'ok';
                return (
                  <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-surface-light)', borderRadius: 'var(--radius-sm)' }}>
                    <span>Keychain backend</span>
                    <span className={ok ? 'status-ok' : 'status-error'} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {ok ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{ok ? 'Ready' : `Error: ${status}`}</span>
                    </span>
                  </div>
                );
              })()}
            </div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              Provider CLI Availability
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '8px' }}>
              {diagResult.providerClis.map((c: any) => (
                <div key={c.name} className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-surface-light)', borderRadius: 'var(--radius-sm)' }}>
                  <span style={{ textTransform: 'capitalize' }}>{c.name} CLI</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className={c.available ? 'status-ok' : 'status-error'} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {c.available ? <CheckCircle size={12} /> : <XCircle size={12} />}
                      <span>{c.available ? 'Installed' : 'Missing'}</span>
                    </span>
                    {c.version && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>({c.version})</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '16px' }}>
            <h4 style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
              MCP Model Context Protocol Config
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingLeft: '8px' }}>
              <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-surface-light)' }}>
                <span>Has .mcp.json file</span>
                <span>{diagResult.mcpConfig.hasMcpJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-surface-light)' }}>
                <span>Has mcp_config.json file</span>
                <span>{diagResult.mcpConfig.hasMcpConfigJson ? 'Yes' : 'No'}</span>
              </div>
              <div className="diag-row" style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 12px', background: 'var(--bg-surface-light)' }}>
                <span>saple-memory tool configured</span>
                <span className={diagResult.mcpConfig.sapleMemoryConfigured ? 'status-ok' : 'status-error'}>
                  {diagResult.mcpConfig.sapleMemoryConfigured ? 'Active' : 'Config Missing'}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : diagError ? (
        <div className="status-error" style={{ padding: '12px', border: '1px solid var(--border)' }}>
          Diagnostics error: {diagError}
        </div>
      ) : (
        <div className="compact-empty" style={{ padding: '30px' }}>
          {!currentProjectPath ? 'Open a workspace first.' : 'No diagnostics data. Run check above.'}
        </div>
      )}
    </section>
  );
};
