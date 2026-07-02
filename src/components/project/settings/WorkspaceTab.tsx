import React, { useState, useEffect } from 'react';
import { CheckCircle, Save, Terminal } from 'lucide-react';
import { useProjectStore } from '../../../stores/projectStore';

export const WorkspaceTab: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const workspaceConfig = useProjectStore((state) => state.workspaceConfig);
  const updateWorkspaceConfig = useProjectStore((state) => state.updateWorkspaceConfig);

  const [workspaceName, setWorkspaceName] = useState('');
  const [memoryMode, setMemoryMode] = useState<'saple' | 'bridge-compatible' | 'both'>('saple');
  const [defaultProvider, setDefaultProvider] = useState('codex');
  const [maxAgents, setMaxAgents] = useState(12);
  const [enableEditMode, setEnableEditMode] = useState(true);
  const [wsSaveStatus, setWsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

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
  );
};
