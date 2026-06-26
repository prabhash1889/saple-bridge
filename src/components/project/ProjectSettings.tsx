import React, { useState, useEffect, useCallback } from 'react';
import {
  CheckCircle,
  Cpu,
  Key,
  Network,
  RefreshCw,
  Save,
  Shield,
  ShieldCheck,
  Terminal,
  Trash2,
  XCircle,
  AlertCircle,
  Clock,
  Database,
  X,
  Play,
  FileText,
  LogIn,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../stores/projectStore';
import { useProviderStore } from '../../stores/providerStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useTerminalStore } from '../../stores/terminalStore';

type SettingsTab = 'keychain' | 'providers' | 'workspace' | 'mcp' | 'memory' | 'sessions' | 'diagnostics';

const tabs: Array<{ id: SettingsTab; label: string; icon: React.ElementType }> = [
  { id: 'keychain', label: 'Keychain', icon: Key },
  { id: 'providers', label: 'Providers', icon: Cpu },
  { id: 'workspace', label: 'Workspace', icon: Terminal },
  { id: 'mcp', label: 'MCP', icon: Network },
  { id: 'memory', label: 'Memory', icon: Database },
  { id: 'sessions', label: 'Sessions', icon: Clock },
  { id: 'diagnostics', label: 'Diagnostics', icon: ShieldCheck },
];

interface McpStatus {
  hasMcpJson: boolean;
  hasMcpConfigJson: boolean;
  sapleMemoryConfigured: boolean;
  otherServers: string[];
  /** saple-memory entry still points at the old embedded server — needs a reinstall. */
  legacyConfig: boolean;
}

const KEYCHAIN_SERVICE_PREFIX = 'saple_provider_';

// The Keychain tab's "OpenAI API Key (for Codex)" slot writes the SAME keychain entry the Codex
// provider card uses (`saple_provider_codex_api_key`), so a key saved in either place reflects in
// both. Previously this tab used the legacy `openai_api_key` service, which silently diverged from
// the provider cards.
const CODEX_KEY_SERVICE = `${KEYCHAIN_SERVICE_PREFIX}codex_api_key`;

// Providers that support subscription "Sign In" via their CLI's interactive login,
// instead of (or in addition to) an API key. The value is the command launched in a
// terminal pane so the user can complete the browser/OAuth flow with their paid plan.
const SIGN_IN_COMMANDS: Partial<Record<string, string>> = {
  claude: 'claude',
  codex: 'codex login',
};

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

export const ProjectSettings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('keychain');
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const workspaceConfig = useProjectStore((state) => state.workspaceConfig);
  const updateWorkspaceConfig = useProjectStore((state) => state.updateWorkspaceConfig);
  const { providers, refreshReadiness, setCustomModel, testRunning, testResults, testProvider } = useProviderStore();

  const [apiKey, setApiKey] = useState('');
  const [isKeySaved, setIsKeySaved] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [keySaveStatus, setKeySaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [keyErrorMessage, setKeyErrorMessage] = useState('');

  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpInstalling, setMcpInstalling] = useState(false);
  const [mcpResult, setMcpResult] = useState<string | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);

  const [workspaceName, setWorkspaceName] = useState('');
  const [memoryMode, setMemoryMode] = useState<'saple' | 'bridge-compatible' | 'both'>('saple');
  const [defaultProvider, setDefaultProvider] = useState('codex');
  const [maxAgents, setMaxAgents] = useState(12);
  const [enableEditMode, setEnableEditMode] = useState(true);
  const [wsSaveStatus, setWsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // MCP Smoke Test States
  const [mcpSmokeLoading, setMcpSmokeLoading] = useState(false);
  const [mcpSmokeResult, setMcpSmokeResult] = useState<any>(null);
  const [mcpSmokeError, setMcpSmokeError] = useState<string | null>(null);

  const [providerKeys, setProviderKeys] = useState<Record<string, { value: string; saved: boolean }>>({});
  const [providerKeySaving, setProviderKeySaving] = useState<Record<string, boolean>>({});
  const [providerKeyStatus, setProviderKeyStatus] = useState<Record<string, 'idle' | 'success' | 'error'>>({});

  // Memory Snapshots
  const { snapshots, loadSnapshots, takeSnapshot, restoreSnapshot } = useMemoryStore();
  const [snapshotName, setSnapshotName] = useState('');
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  // Agent Sessions
  const { sessions, loadSessions, setSessionStatus, saveSessions } = useAgentSessionStore();
  const [activeLogContent, setActiveLogContent] = useState<string | null>(null);
  const [activeLogTitle, setActiveLogTitle] = useState<string | null>(null);

  // Diagnostics
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<any | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);

  const confirmAction = (opts: any) => useConfirmStore.getState().confirm(opts);
  const successNotification = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const errorNotification = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  useEffect(() => {
    if (activeTab === 'memory' && currentProjectPath) {
      loadSnapshots(currentProjectPath);
    }
  }, [activeTab, currentProjectPath, loadSnapshots]);

  useEffect(() => {
    if (activeTab === 'sessions' && currentProjectPath) {
      loadSessions(currentProjectPath);
    }
  }, [activeTab, currentProjectPath, loadSessions]);

  useEffect(() => { checkApiKeyPresence(); }, []);
  useEffect(() => { if (workspaceConfig) { setWorkspaceName(workspaceConfig.workspaceName); setMemoryMode(workspaceConfig.memoryMode); setDefaultProvider(workspaceConfig.defaultProvider); setMaxAgents(workspaceConfig.maxParallelAgents); setEnableEditMode(workspaceConfig.enableEditMode ?? true); } }, [workspaceConfig]);
  useEffect(() => { if (activeTab === 'mcp' && currentProjectPath) { refreshMcpStatus(); } }, [activeTab, currentProjectPath]);
  useEffect(() => { if (activeTab === 'providers') { refreshReadiness(); } }, [activeTab, refreshReadiness]);
  useEffect(() => {
    if (activeTab === 'providers') {
      providers.forEach(async (p) => {
        if (providerKeys[p.provider]) return;
        try {
          const saved = await invoke<boolean>('has_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${p.provider}_api_key` });
          if (saved) {
            setProviderKeys(prev => ({ ...prev, [p.provider]: { value: '\u2022'.repeat(32), saved: true } }));
          } else {
            setProviderKeys(prev => ({ ...prev, [p.provider]: { value: '', saved: false } }));
          }
        } catch {
          setProviderKeys(prev => ({ ...prev, [p.provider]: { value: '', saved: false } }));
        }
      });
    }
  }, [activeTab, providers]);

  const checkApiKeyPresence = async () => {
    try {
      const saved = await invoke<boolean>('has_api_key', { service: CODEX_KEY_SERVICE });
      if (saved) {
        setIsKeySaved(true);
        setApiKey('•'.repeat(32));
      } else {
        setIsKeySaved(false);
        setApiKey('');
      }
    } catch {
      setIsKeySaved(false);
      setApiKey('');
    }
  };

  const handleKeySave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim()) return;
    if (apiKey === '•'.repeat(32)) return;
    setKeyLoading(true);
    setKeySaveStatus('idle');
    setKeyErrorMessage('');
    try {
      await invoke('set_api_key', { service: CODEX_KEY_SERVICE, key: apiKey });
      setKeySaveStatus('success');
      setIsKeySaved(true);
      setApiKey('•'.repeat(32));
      // Reflect the new key in the provider cards' readiness/"Key saved" badge immediately.
      refreshReadiness();
      setTimeout(() => setKeySaveStatus('idle'), 3000);
    } catch (err: any) {
      setKeySaveStatus('error');
      setKeyErrorMessage(err.toString());
    } finally {
      setKeyLoading(false);
    }
  };

  const handleKeyDelete = async () => {
    setKeyLoading(true);
    try {
      await invoke('delete_api_key', { service: CODEX_KEY_SERVICE });
      setIsKeySaved(false);
      setApiKey('');
      refreshReadiness();
    } catch {
      // ignore
    } finally {
      setKeyLoading(false);
    }
  };

  const handleProviderKeySave = async (provider: string) => {
    const key = providerKeys[provider]?.value;
    if (!key || key === '\u2022'.repeat(32)) return;
    setProviderKeySaving(prev => ({ ...prev, [provider]: true }));
    setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
    try {
      await invoke('set_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${provider}_api_key`, key });
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'success' }));
      setProviderKeys(prev => ({ ...prev, [provider]: { value: '\u2022'.repeat(32), saved: true } }));
      refreshReadiness();
      setTimeout(() => setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' })), 3000);
    } catch {
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'error' }));
    } finally {
      setProviderKeySaving(prev => ({ ...prev, [provider]: false }));
    }
  };

  const handleProviderKeyDelete = async (provider: string) => {
    setProviderKeySaving(prev => ({ ...prev, [provider]: true }));
    try {
      await invoke('delete_api_key', { service: `${KEYCHAIN_SERVICE_PREFIX}${provider}_api_key` });
      setProviderKeys(prev => ({ ...prev, [provider]: { value: '', saved: false } }));
      setProviderKeyStatus(prev => ({ ...prev, [provider]: 'idle' }));
      refreshReadiness();
    } catch {
      // ignore
    } finally {
      setProviderKeySaving(prev => ({ ...prev, [provider]: false }));
    }
  };

  const handleProviderSignIn = async (provider: string) => {
    const command = SIGN_IN_COMMANDS[provider];
    if (!command) return;
    if (!currentProjectPath) {
      errorNotification('Open a workspace first', 'Sign-in runs in a terminal inside a workspace.');
      return;
    }
    try {
      // Launch the CLI's interactive login as a custom-command terminal, then jump to it so the
      // user can complete the subscription/OAuth flow. No API key is injected for this pane.
      await useTerminalStore.getState().addPane(currentProjectPath, 'custom', undefined, undefined, command);
      useProjectStore.getState().setActiveView('terminals');
      successNotification(`Launching ${provider} sign-in`, 'Complete the login in the new terminal.');
    } catch (err: any) {
      errorNotification('Failed to start sign-in', err?.toString?.());
    }
  };

  const refreshMcpStatus = useCallback(async () => {
    if (!currentProjectPath) return;
    try {
      const status = await invoke<McpStatus>('check_mcp_status', { projectPath: currentProjectPath });
      setMcpStatus(status);
    } catch {
      setMcpStatus(null);
    }
  }, [currentProjectPath]);

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

  const handleWsSave = async () => {
    await updateWorkspaceConfig({
      workspaceName,
      memoryMode,
      defaultProvider,
      maxParallelAgents: maxAgents,
      enableEditMode,
    });
    setWsSaveStatus('success');
    setTimeout(() => setWsSaveStatus('idle'), 3000);
  };

  return (
    <div className="settings-shell">
      <div className="room-header">
        <h2>Settings</h2>
        <p>Configure provider credentials, workspace defaults, and MCP integration.</p>
      </div>

      <div className="settings-tabs" role="tablist">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
              aria-selected={activeTab === tab.id}
            >
              <Icon size={15} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      <div className="settings-content">
        {activeTab === 'keychain' && (
          <section className="surface">
            <div className="section-header">
              <Shield size={18} className="section-icon" />
              <span className="section-title">OS Keychain Storage</span>
            </div>
            <p className="section-desc">
              API keys are stored in your OS native credential manager (Windows Credential Manager / macOS Keychain). Never stored in plaintext files. This is the same key slot as the <strong>Codex</strong> card under the Providers tab — saving here updates both.
            </p>
            <form onSubmit={handleKeySave} className="settings-form">
              <div className="input-group">
                <label className="input-label">
                  <Key size={14} />
                  OpenAI API Key (for Codex)
                </label>
                <div className="input-wrapper">
                  <input
                    type="password"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    placeholder="sk-or-..."
                    className="settings-input"
                    disabled={keyLoading}
                  />
                  {isKeySaved && (
                    <button type="button" onClick={handleKeyDelete} className="icon-button danger" title="Remove saved key" disabled={keyLoading}>
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="primary" disabled={keyLoading || !apiKey.trim() || apiKey === '•'.repeat(32)}>
                  <Save size={15} />
                  <span>{keyLoading ? 'Saving...' : 'Save API Key'}</span>
                </button>
                {keySaveStatus === 'success' && <span className="status-ok"><CheckCircle size={14} /> Saved to OS Keychain</span>}
                {keySaveStatus === 'error' && <span className="status-error">Failed: {keyErrorMessage}</span>}
              </div>
            </form>
          </section>
        )}

        {activeTab === 'providers' && (
          <section className="surface">
            <div className="section-header">
              <Cpu size={18} className="section-icon" />
              <span className="section-title">Provider Configuration</span>
            </div>
            <p className="section-desc">
              Manage AI provider CLIs and API keys. Provider CLIs must be installed separately. API keys are stored in the OS keychain.
            </p>
            <div className="provider-grid">
              {providers.map((p) => (
                <div key={p.provider} className={`provider-card ${p.authenticated === true || p.signedIn === true ? 'provider-ready' : ''}`}>
                  <div className="provider-card-header">
                    <div className="provider-card-title">
                      <strong>{p.label}</strong>
                      <code className="provider-cli">{p.cliCommand || 'No CLI command'}</code>
                    </div>
                    <span className={`provider-status-dot ${p.authenticated === true || p.signedIn === true ? 'ready' : p.authenticated === false ? 'missing' : 'pending'}`} />
                  </div>

                  <div className="provider-card-body">
                    {SIGN_IN_COMMANDS[p.provider] && (
                      <div className="provider-signin-note" style={{ fontSize: '11.5px', color: 'var(--text-secondary)', marginBottom: '8px', lineHeight: 1.4 }}>
                        On a paid {p.label} subscription? Use <strong>Sign In</strong> to log in with your plan — no API key required. An API key below is optional and only needed for pay-as-you-go billing.
                      </div>
                    )}
                    <div className="provider-detail-row">
                      <span className="provider-detail-label">Auth</span>
                      {p.authenticated === true ? (
                        <span className="status-ok"><CheckCircle size={12} /> Key saved</span>
                      ) : p.signedIn === true ? (
                        <span className="status-ok"><CheckCircle size={12} /> Signed in</span>
                      ) : p.authenticated === false ? (
                        <span className="status-error"><XCircle size={12} /> No key</span>
                      ) : (
                        <span className="provider-detail-pending">Checking...</span>
                      )}
                    </div>
                    {p.cliCommand && (
                      <div className="provider-detail-row">
                        <span className="provider-detail-label">Installed</span>
                        {p.installed === true ? (
                          <span className="status-ok" title={p.version || undefined}>
                            <CheckCircle size={12} /> Installed{p.version ? ` (${p.version})` : ''}
                          </span>
                        ) : p.installed === false ? (
                          <span className="status-error"><XCircle size={12} /> Not found</span>
                        ) : (
                          <span className="provider-detail-pending">Checking...</span>
                        )}
                      </div>
                    )}
                    <div className="provider-detail-row">
                      <span className="provider-detail-label">Default model</span>
                      <span className="provider-detail-value">{p.defaultModel || '—'}</span>
                    </div>
                    {p.provider === 'custom' && (
                      <div className="provider-detail-row">
                        <span className="provider-detail-label">Custom model</span>
                        <input
                          type="text"
                          value={p.customModel}
                          onChange={(e) => setCustomModel(p.provider, e.target.value)}
                          placeholder="e.g. gpt-4o-mini"
                          className="settings-input provider-model-input"
                        />
                      </div>
                    )}
                  </div>

                  <div className="provider-card-actions">
                    <div className="input-wrapper">
                      <input
                        type="password"
                        value={providerKeys[p.provider]?.value || ''}
                        onChange={(e) => setProviderKeys(prev => ({ ...prev, [p.provider]: { value: e.target.value, saved: false } }))}
                        placeholder="Enter API key..."
                        className="settings-input provider-key-input"
                        disabled={providerKeySaving[p.provider]}
                      />
                      {providerKeys[p.provider]?.saved && (
                        <button
                          type="button"
                          onClick={() => handleProviderKeyDelete(p.provider)}
                          className="icon-button danger"
                          title="Remove saved key"
                          disabled={providerKeySaving[p.provider]}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                    <div className="provider-card-actions-row">
                      <button
                        onClick={() => handleProviderKeySave(p.provider)}
                        className="primary provider-action-btn"
                        disabled={providerKeySaving[p.provider] || !providerKeys[p.provider]?.value || providerKeys[p.provider]?.value === '\u2022'.repeat(32)}
                      >
                        <Save size={13} />
                        <span>{providerKeySaving[p.provider] ? 'Saving...' : 'Save Key'}</span>
                      </button>
                      <button
                        onClick={() => testProvider(p.provider)}
                        className="provider-action-btn"
                        disabled={testRunning[p.provider]}
                      >
                        <RefreshCw size={13} />
                        <span>{testRunning[p.provider] ? 'Testing...' : 'Test'}</span>
                      </button>
                      {SIGN_IN_COMMANDS[p.provider] && (
                        <button
                          onClick={() => handleProviderSignIn(p.provider)}
                          className="provider-action-btn"
                          title={`Sign in to ${p.label} with your subscription`}
                        >
                          <LogIn size={13} />
                          <span>Sign In</span>
                        </button>
                      )}
                    </div>
                    {providerKeyStatus[p.provider] === 'success' && <span className="status-ok"><CheckCircle size={12} /> Key saved</span>}
                    {testResults[p.provider] === 'success' && <span className="status-ok"><CheckCircle size={12} /> Connection OK</span>}
                    {testResults[p.provider] === 'error' && <span className="status-error"><AlertCircle size={12} /> No API key or sign-in found</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'workspace' && (
          <section className="surface">
            <div className="section-header">
              <Terminal size={18} className="section-icon" />
              <span className="section-title">Workspace Configuration</span>
            </div>
            <p className="section-desc">
              Edit how this workspace behaves. Changes are saved to <code>.saple/config.json</code>.
            </p>
            {!currentProjectPath ? (
              <div className="compact-empty">Open a workspace to configure it.</div>
            ) : (
              <div className="settings-form">
                <div className="input-group">
                  <label className="input-label">Display Name</label>
                  <input
                    type="text"
                    value={workspaceName}
                    onChange={e => setWorkspaceName(e.target.value)}
                    className="settings-input"
                  />
                </div>
                <div className="input-group">
                  <label className="input-label">Memory Mode</label>
                  <select value={memoryMode} onChange={e => setMemoryMode(e.target.value as any)} className="settings-select">
                    <option value="saple">Saple (.saple/memory)</option>
                    <option value="bridge-compatible">Bridge-compatible (.bridgememory)</option>
                    <option value="both">Both</option>
                  </select>
                </div>
                <div className="input-group">
                  <label className="input-label">Default Provider</label>
                  <select value={defaultProvider} onChange={e => setDefaultProvider(e.target.value)} className="settings-select">
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                    <option value="gemini">Gemini</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="pi">Pi</option>
                    <option value="opencode">OpenCode</option>
                    <option value="custom">Custom</option>
                  </select>
                </div>
                <div className="input-group">
                  <label className="input-label">Max Parallel Agents</label>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={maxAgents}
                    onChange={e => setMaxAgents(parseInt(e.target.value) || 12)}
                    className="settings-input settings-input-narrow"
                  />
                </div>
                <div className="input-group checkbox-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '8px', marginTop: '14px', marginBottom: '14px' }}>
                  <input
                    type="checkbox"
                    id="enableEditMode"
                    checked={enableEditMode}
                    onChange={e => setEnableEditMode(e.target.checked)}
                    style={{ margin: 0, width: 'auto', cursor: 'pointer' }}
                  />
                  <label htmlFor="enableEditMode" style={{ fontWeight: 'normal', cursor: 'pointer', margin: 0, userSelect: 'none' }}>
                    Enable File Editing (allows modifying files via file browser)
                  </label>
                </div>
                <div className="form-actions">
                  <button onClick={handleWsSave} className="primary">
                    <Save size={15} />
                    <span>Save Configuration</span>
                  </button>
                  {wsSaveStatus === 'success' && <span className="status-ok"><CheckCircle size={14} /> Saved to .saple/config.json</span>}
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === 'mcp' && (
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
                  <div className="mcp-legacy-warning" role="alert" style={{
                    display: 'flex', gap: '8px', alignItems: 'flex-start',
                    padding: '10px 12px', marginBottom: '12px', borderRadius: '8px',
                    border: '1px solid var(--warning, #b58900)',
                    background: 'color-mix(in srgb, var(--warning, #b58900) 12%, transparent)',
                  }}>
                    <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px', color: 'var(--warning, #b58900)' }} />
                    <span style={{ fontSize: '12px', lineHeight: 1.5 }}>
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

                <div style={{ marginTop: '24px', borderTop: '1px solid var(--border)', paddingTop: '20px' }}>
                  <h4 style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '8px' }}>
                    MCP Server Diagnostics & Tools Validation
                  </h4>
                  <p className="section-desc">
                    Smoke test the MCP JSON-RPC protocol interface to verify registered tools and capabilities.
                  </p>
                  
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '16px' }}>
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
                          <strong style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                            {tool.name}
                          </strong>
                          <p style={{ margin: '4px 0 0 0', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
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
        )}

        {activeTab === 'memory' && (
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
        )}

        {activeTab === 'sessions' && (
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
        )}

        {activeTab === 'diagnostics' && (
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
        )}
      </div>

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
    </div>
  );
};
