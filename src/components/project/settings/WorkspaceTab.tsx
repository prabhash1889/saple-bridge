import React, { useState, useEffect } from 'react';
import { CheckCircle, Save, Terminal } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore } from '../../../stores/projectStore';
import { useTerminalFontStore } from '../../../stores/terminalFontStore';
import { MIN_SCROLLBACK_ROWS, MAX_SCROLLBACK_ROWS } from '../../../lib/terminalLimits';
import { SshPresetsSection } from './SshPresetsSection';

export const WorkspaceTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const workspaceConfig = useProjectStore((state) => state.workspaceConfig);
  const updateWorkspaceConfig = useProjectStore((state) => state.updateWorkspaceConfig);

  const [workspaceName, setWorkspaceName] = useState('');
  const [memoryMode, setMemoryMode] = useState<'saple' | 'bridge-compatible' | 'both'>('saple');
  const [defaultProvider, setDefaultProvider] = useState('codex');
  const [maxAgents, setMaxAgents] = useState(12);
  const [enableEditMode, setEnableEditMode] = useState(true);
  const [verificationPresets, setVerificationPresets] = useState('');
  const [wsSaveStatus, setWsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Terminal scrollback is an app-wide preference (persisted to localStorage), so it saves
  // immediately on change rather than through the workspace-config Save button.
  const scrollbackRows = useTerminalFontStore((state) => state.scrollbackRows);
  const setScrollbackRows = useTerminalFontStore((state) => state.setScrollbackRows);

  // Agent browser control is app-global and Windows-only (WebView2 remote-debugging port).
  // navigator.userAgent reliably reports "Windows NT" in WebView2 vs "Macintosh" in WKWebView.
  const isWindows = navigator.userAgent.includes('Windows');
  const [agentBrowser, setAgentBrowser] = useState(false);
  useEffect(() => {
    if (isWindows) {
      invoke<boolean>('agent_browser_get_enabled').then(setAgentBrowser).catch(() => {});
    }
  }, [isWindows]);

  const toggleAgentBrowser = async (enabled: boolean) => {
    setAgentBrowser(enabled); // optimistic; the flag write is fast and rarely fails
    try {
      await invoke('agent_browser_set_enabled', { enabled });
    } catch {
      setAgentBrowser(!enabled);
    }
  };

  const [juneControl, setJuneControl] = useState(false);
  useEffect(() => {
    invoke<boolean>('june_control_get_enabled').then(setJuneControl).catch(() => {});
  }, []);

  const toggleJuneControl = async (enabled: boolean) => {
    setJuneControl(enabled); // optimistic; the flag write is fast and rarely fails
    try {
      await invoke('june_control_set_enabled', { enabled });
    } catch {
      setJuneControl(!enabled);
    }
  };

  useEffect(() => {
    if (workspaceConfig) {
      setWorkspaceName(workspaceConfig.workspaceName);
      setMemoryMode(workspaceConfig.memoryMode);
      setDefaultProvider(workspaceConfig.defaultProvider);
      setMaxAgents(workspaceConfig.maxParallelAgents);
      setEnableEditMode(workspaceConfig.enableEditMode ?? true);
      setVerificationPresets((workspaceConfig.verificationPresets ?? []).join('\n'));
    }
  }, [workspaceConfig]);

  const handleWsSave = async () => {
    await updateWorkspaceConfig({
      workspaceName,
      memoryMode,
      defaultProvider,
      maxParallelAgents: maxAgents,
      enableEditMode,
      verificationPresets: verificationPresets
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    });
    setWsSaveStatus('success');
    setTimeout(() => setWsSaveStatus('idle'), 3000);
  };

  return (
    <>
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
            <select value={memoryMode} onChange={e => setMemoryMode(e.target.value as 'saple' | 'bridge-compatible' | 'both')} className="settings-select">
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
          <div className="input-group">
            <label className="input-label">Terminal Scrollback (rows)</label>
            <input
              type="number"
              min={MIN_SCROLLBACK_ROWS}
              max={MAX_SCROLLBACK_ROWS}
              step={1000}
              value={scrollbackRows}
              onChange={e => setScrollbackRows(parseInt(e.target.value) || MIN_SCROLLBACK_ROWS)}
              className="settings-input settings-input-narrow"
            />
            <span className="input-hint">Applied live to all panes. App-wide preference.</span>
          </div>
          <div className="input-group">
            <label className="input-label">Review Verification Presets (one command per line)</label>
            <textarea
              rows={3}
              value={verificationPresets}
              onChange={e => setVerificationPresets(e.target.value)}
              placeholder={'npm test\ncargo test'}
              className="settings-input"
              spellCheck={false}
            />
            <span className="input-hint">Shown as one-click presets in the Review room's Verification tab.</span>
          </div>
          <div className="settings-checkbox-row input-group checkbox-group">
            <input
              type="checkbox"
              id="enableEditMode"
              checked={enableEditMode}
              onChange={e => setEnableEditMode(e.target.checked)} className="settings-checkbox"
            />
            <label htmlFor="enableEditMode" className="settings-checkbox-label">
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
    {isWindows && (
      <section className="surface">
        <div className="section-header">
          <Terminal size={18} className="section-icon" />
          <span className="section-title">Agent Browser Control</span>
        </div>
        <p className="section-desc">
          Let external automation drive the embedded browser tabs over the Chrome DevTools
          Protocol (Playwright, Puppeteer, or a CDP MCP server). When on, the app launches with a
          loopback debugging endpoint at <code>127.0.0.1:9222</code>.
        </p>
        <div className="settings-checkbox-row input-group checkbox-group">
          <input
            type="checkbox"
            id="agentBrowserControl"
            checked={agentBrowser}
            onChange={e => toggleAgentBrowser(e.target.checked)}
            className="settings-checkbox"
          />
          <label htmlFor="agentBrowserControl" className="settings-checkbox-label">
            Allow agents to control the embedded browser (requires app restart)
          </label>
        </div>
        <p className="input-hint">
          Security: the debugging port grants control of every webview in this app, including the
          app shell. Only enable it on a machine you trust. Leave off unless you need agent-driven
          browsing.
        </p>
      </section>
    )}
    <section className="surface">
      <div className="section-header">
        <Terminal size={18} className="section-icon" />
        <span className="section-title">June Voice Control</span>
      </div>
      <p className="section-desc">
        Let June (the voice agent) drive this workspace - spawn agents, assign tasks, control
        terminals and the browser - over a token-authed loopback endpoint. When on, the app
        publishes a discovery record June reads to connect.
      </p>
      <div className="settings-checkbox-row input-group checkbox-group">
        <input
          type="checkbox"
          id="juneControl"
          checked={juneControl}
          onChange={e => toggleJuneControl(e.target.checked)}
          className="settings-checkbox"
        />
        <label htmlFor="juneControl" className="settings-checkbox-label">
          Allow June to control this workspace (requires app restart)
        </label>
      </div>
      <p className="input-hint">
        Security: the endpoint is loopback-only and every mutating command is token-authed, but it
        can spawn and control agents in the open workspace. Leave off unless you use June.
      </p>
    </section>
    <SshPresetsSection />
    </>
  );
};
