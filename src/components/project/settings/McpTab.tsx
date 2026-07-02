import React, { useState, useEffect, useCallback } from 'react';
import { AlertCircle, CheckCircle, Network, RefreshCw, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';

interface McpStatus {
  hasMcpJson: boolean;
  hasMcpConfigJson: boolean;
  sapleMemoryConfigured: boolean;
  otherServers: string[];
  /** saple-memory entry still points at the old embedded server — needs a reinstall. */
  legacyConfig: boolean;
}

const mcpToolsListStyle: React.CSSProperties = {
  maxHeight: '240px',
  overflowY: 'auto',
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '10px',
  padding: '12px',
  backgroundColor: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  marginTop: '10px',
};

const mcpToolCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface-light)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
};

export const McpTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);

  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpInstalling, setMcpInstalling] = useState(false);
  const [mcpResult, setMcpResult] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const [mcpSmokeLoading, setMcpSmokeLoading] = useState(false);
  const [mcpSmokeResult, setMcpSmokeResult] = useState<any>(null);
  const [mcpSmokeError, setMcpSmokeError] = useState<string | null>(null);

  const refreshMcpStatus = useCallback(async () => {
    if (!currentProjectPath) return;
    try {
      const status = await invoke<McpStatus>('check_mcp_status', { projectPath: currentProjectPath });
      setMcpStatus(status);
    } catch {
      setMcpStatus(null);
    }
  }, [currentProjectPath]);

  useEffect(() => { if (currentProjectPath) { refreshMcpStatus(); } }, [currentProjectPath, refreshMcpStatus]);

  const handleInstallMcp = async () => {
    if (!currentProjectPath) return;
    setMcpInstalling(true);
    setMcpResult(null);
    setMcpError(null);
    try {
      const result = await invoke<string>('install_mcp_config', { projectPath: currentProjectPath });
      setMcpResult(result);
      await refreshMcpStatus();
    } catch (err: any) {
      setMcpError(err.toString());
    } finally {
      setMcpInstalling(false);
    }
  };

  const handleRunMcpSmokeTest = async () => {
    if (!currentProjectPath) return;
    setMcpSmokeLoading(true);
    setMcpSmokeResult(null);
    setMcpSmokeError(null);
    try {
      const result = await invoke<any>('test_mcp_tools', { projectPath: currentProjectPath });
      setMcpSmokeResult(result);
    } catch (err: any) {
      setMcpSmokeError(err.toString());
    } finally {
      setMcpSmokeLoading(false);
    }
  };

  return (
    <section className="surface">
      <div className="section-header">
        <Network size={18} className="section-icon" />
        <span className="section-title">MCP Configuration</span>
      </div>
      <p className="section-desc">
        The MCP (Model Context Protocol) config tells AI editors like Cursor, Windsurf, or Claude Desktop how to connect to the Saple Memory server. Install it explicitly when you want agents to access your project knowledge graph.
      </p>

      {!currentProjectPath ? (
        <div className="compact-empty">Open a workspace to manage MCP config.</div>
      ) : (
        <>
          {mcpStatus && (
            <div className="mcp-status-grid">
              <div className={`mcp-status-item ${mcpStatus.hasMcpJson ? 'ok' : 'missing'}`}>
                {mcpStatus.hasMcpJson ? <CheckCircle size={14} /> : <XCircle size={14} />}
                <span>.mcp.json</span>
              </div>
              <div className={`mcp-status-item ${mcpStatus.hasMcpConfigJson ? 'ok' : 'missing'}`}>
                {mcpStatus.hasMcpConfigJson ? <CheckCircle size={14} /> : <XCircle size={14} />}
                <span>mcp_config.json</span>
              </div>
              <div className={`mcp-status-item ${mcpStatus.sapleMemoryConfigured ? 'ok' : 'missing'}`}>
                {mcpStatus.sapleMemoryConfigured ? <CheckCircle size={14} /> : <XCircle size={14} />}
                <span>saple-memory server</span>
              </div>
              {mcpStatus.otherServers.length > 0 && (
                <div className="mcp-other-servers">
                  <span>Other servers preserved: {mcpStatus.otherServers.join(', ')}</span>
                </div>
              )}
            </div>
          )}

          {mcpStatus?.legacyConfig && (
            <div className="extracted-style-052 mcp-legacy-warning" role="alert">
              <AlertCircle size={15} className="extracted-style-053" />
              <span className="extracted-style-054">
                This project's MCP config points at the <strong>old embedded server</strong>, which no longer
                runs (it now launches the Bridge window instead). Click <strong>Install Saple MCP Config</strong>
                below to update it to the standalone <strong>saple-mcp</strong> server.
              </span>
            </div>
          )}

          <div className="mcp-preview">
            <strong>Files that will be written:</strong>
            <code>.mcp.json</code>
            <code>mcp_config.json</code>
            <p className="section-desc">Existing MCP servers in these files will be preserved. Only the <strong>saple-memory</strong> entry will be added or updated.</p>
          </div>

          <div className="form-actions">
            <button onClick={handleInstallMcp} className="primary" disabled={mcpInstalling}>
              <Network size={15} />
              <span>{mcpInstalling ? 'Installing...' : 'Install Saple MCP Config'}</span>
            </button>
            {mcpResult && <span className="status-ok"><CheckCircle size={14} /> MCP config installed</span>}
            {mcpError && <span className="status-error">Failed: {mcpError}</span>}
          </div>

          <div className="extracted-style-055">
            <h4 className="extracted-style-056">
              MCP Server Diagnostics & Tools Validation
            </h4>
            <p className="section-desc">
              Smoke test the MCP JSON-RPC protocol interface to verify registered tools and capabilities.
            </p>

            <div className="extracted-style-057">
              <button onClick={handleRunMcpSmokeTest} disabled={mcpSmokeLoading} className="secondary">
                <RefreshCw size={14} className={mcpSmokeLoading ? 'spin' : ''} />
                <span>{mcpSmokeLoading ? 'Testing...' : 'Run Tools Smoke Test'}</span>
              </button>
              {mcpSmokeResult && (
                <span className="status-ok">
                  <CheckCircle size={14} />
                  <span>Tools validated successfully ({mcpSmokeResult.tools?.length || 0} tools found)</span>
                </span>
              )}
              {mcpSmokeError && (
                <span className="status-error">
                  <XCircle size={14} />
                  <span>Smoke test failed: {mcpSmokeError}</span>
                </span>
              )}
            </div>

            {mcpSmokeResult && mcpSmokeResult.tools && (
              <div style={mcpToolsListStyle}>
                {mcpSmokeResult.tools.map((tool: any) => (
                  <div key={tool.name} style={mcpToolCardStyle}>
                    <strong className="extracted-style-058">
                      {tool.name}
                    </strong>
                    <p className="extracted-style-059">
                      {tool.description}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};
