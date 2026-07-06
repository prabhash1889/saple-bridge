import React, { useState, useEffect } from 'react';
import { CheckCircle, Save, Terminal } from 'lucide-react';
import { useProjectStore } from '../../../stores/projectStore';
import {
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_SCROLLBACK,
  useTerminalFontStore,
} from '../../../stores/terminalFontStore';

export const WorkspaceTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const workspaceConfig = useProjectStore((state) => state.workspaceConfig);
  const updateWorkspaceConfig = useProjectStore((state) => state.updateWorkspaceConfig);
  // Scrollback is an app-wide terminal preference (like the font), persisted immediately.
  const scrollbackRows = useTerminalFontStore((state) => state.scrollbackRows);
  const setScrollbackRows = useTerminalFontStore((state) => state.setScrollbackRows);

  const [workspaceName, setWorkspaceName] = useState('');
  const [memoryMode, setMemoryMode] = useState<'saple' | 'bridge-compatible' | 'both'>('saple');
  const [defaultProvider, setDefaultProvider] = useState('codex');
  const [maxAgents, setMaxAgents] = useState(12);
  const [enableEditMode, setEnableEditMode] = useState(true);
  const [wsSaveStatus, setWsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  // Local draft so intermediate keystrokes aren't clamped mid-typing; committed on blur.
  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackRows));

  useEffect(() => {
    setScrollbackDraft(String(scrollbackRows));
  }, [scrollbackRows]);

  const commitScrollback = () => {
    const parsed = parseInt(scrollbackDraft, 10);
    if (Number.isFinite(parsed)) setScrollbackRows(parsed);
    else setScrollbackDraft(String(scrollbackRows));
  };

  useEffect(() => {
    if (workspaceConfig) {
      setWorkspaceName(workspaceConfig.workspaceName);
      setMemoryMode(workspaceConfig.memoryMode);
      setDefaultProvider(workspaceConfig.defaultProvider);
      setMaxAgents(workspaceConfig.maxParallelAgents);
      setEnableEditMode(workspaceConfig.enableEditMode ?? true);
    }
  }, [workspaceConfig]);

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

    <section className="surface">
      <div className="section-header">
        <Terminal size={18} className="section-icon" />
        <span className="section-title">Terminal Preferences</span>
      </div>
      <p className="section-desc">
        Applies to every terminal pane across all workspaces. Saved on this device.
      </p>
      <div className="settings-form">
        <div className="input-group">
          <label className="input-label" htmlFor="terminal-scrollback">Scrollback (lines)</label>
          <input
            id="terminal-scrollback"
            type="number"
            min={MIN_TERMINAL_SCROLLBACK}
            max={MAX_TERMINAL_SCROLLBACK}
            step={1000}
            value={scrollbackDraft}
            onChange={e => setScrollbackDraft(e.target.value)}
            onBlur={commitScrollback}
            className="settings-input settings-input-narrow"
          />
          <p className="settings-help-text">
            How many lines of history each pane keeps ({MIN_TERMINAL_SCROLLBACK.toLocaleString()}–{MAX_TERMINAL_SCROLLBACK.toLocaleString()}).
          </p>
        </div>
      </div>
    </section>
    </>
  );
};
