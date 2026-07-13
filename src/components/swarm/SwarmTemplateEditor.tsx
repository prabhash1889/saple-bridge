import React, { useState } from 'react';
import { Plus, Trash, Save, AlertCircle } from 'lucide-react';
import { SwarmTemplate, SwarmAgent, useSwarmStore, AgentRole } from '../../stores/swarmStore';
import { AgentProvider } from '../../types/provider';
import { PROVIDER_ORDER, PROVIDER_LABELS, PROVIDER_DEFAULT_MODEL } from './wizard/providerMeta';
import { ModelCombobox } from '../common/ModelCombobox';
import { invoke } from '@tauri-apps/api/core';

interface SwarmTemplateEditorProps {
  template: SwarmTemplate;
  onSave: () => void;
  onCancel: () => void;
}

export const SwarmTemplateEditor: React.FC<SwarmTemplateEditorProps> = ({
  template,
  onSave,
  onCancel
}) => {
  const { saveTemplatePreset } = useSwarmStore();
  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  
  // Convert Omit<SwarmAgent, 'status' | 'taskId' | 'terminalId'> to a stateful list
  const [agents, setAgents] = useState<Array<Omit<SwarmAgent, 'status' | 'taskId' | 'terminalId'>>>(
    template.agents.map(a => ({ ...a }))
  );

  const [validationError, setValidationError] = useState<string | null>(null);

  const handleAddAgent = () => {
    const newId = `agent_${Date.now()}`;
    setAgents([
      ...agents,
      {
        id: newId,
        name: 'New Agent',
        role: 'builder' as AgentRole,
        provider: 'codex',
        model: PROVIDER_DEFAULT_MODEL.codex,
        dependencies: [],
        systemPrompt: 'You are a helpful coding agent.'
      }
    ]);
  };

  const handleRemoveAgent = (id: string) => {
    setAgents(agents.filter(a => a.id !== id).map(a => ({
      ...a,
      dependencies: a.dependencies.filter(depId => depId !== id)
    })));
  };

  const handleUpdateAgent = (id: string, updates: Partial<Omit<SwarmAgent, 'status' | 'taskId' | 'terminalId'>>) => {
    setAgents(agents.map(a => a.id === id ? { ...a, ...updates } : a));
  };

  const handleToggleDependency = (agentId: string, depId: string) => {
    setAgents(agents.map(a => {
      if (a.id !== agentId) return a;
      const deps = a.dependencies.includes(depId)
        ? a.dependencies.filter(d => d !== depId)
        : [...a.dependencies, depId];
      return { ...a, dependencies: deps };
    }));
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setValidationError('Template name cannot be empty.');
      return;
    }

    if (agents.length === 0) {
      setValidationError('A swarm must contain at least one agent.');
      return;
    }

    // Call Rust to validate the dependency graph (cycle detection)
    try {
      // Map to struct expected by Rust
      const rustAgents = agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        model: a.model,
        systemPrompt: a.systemPrompt,
        dependencies: a.dependencies,
        status: 'idle', // Temp status for Rust validation
        taskId: null,
        terminalId: null
      }));

      const isValid = await invoke<boolean>('validate_dependency_graph', { agents: rustAgents });
      if (!isValid) {
        setValidationError('Invalid dependency graph: A cycle was detected in the agent dependencies!');
        return;
      }
    } catch (err) {
      setValidationError(`Validation failed: ${err}`);
      return;
    }

    setValidationError(null);

    // Save template preset
    saveTemplatePreset({
      id: template.id,
      name,
      description,
      agents
    });

    onSave();
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div>
          <h3 className="swarm-panel-title">
            Modify Swarm Template Preset
          </h3>
          <p className="swarm-panel-subtitle">
            Customize the coordinator and builder agents, models, prompts, and dependencies.
          </p>
        </div>
        <div className="swarm-row-10">
          <button onClick={onCancel} style={btnSecondaryStyle}>Cancel</button>
          <button onClick={handleSave} className="primary" style={btnPrimaryStyle}>
            <Save size={13} />
            <span>Save Preset</span>
          </button>
        </div>
      </div>

      {validationError && (
        <div style={errorBannerStyle}>
          <AlertCircle size={14} />
          <span>{validationError}</span>
        </div>
      )}

      <div style={editorFormStyle}>
        <div style={formRowStyle}>
          <div className="flex-1">
            <label style={labelStyle}>Template Name</label>
            <input 
              type="text" 
              value={name} 
              onChange={e => setName(e.target.value)} 
              style={inputStyle}
            />
          </div>
          <div className="flex-2">
            <label style={labelStyle}>Description</label>
            <input 
              type="text" 
              value={description} 
              onChange={e => setDescription(e.target.value)} 
              style={inputStyle}
            />
          </div>
        </div>

        <div style={agentsSectionHeaderStyle}>
          <h4 className="swarm-col-label">
            Agent Nodes Configuration
          </h4>
          <button onClick={handleAddAgent} style={btnAddAgentStyle}>
            <Plus size={12} />
            <span>Add Agent</span>
          </button>
        </div>

        <div style={agentsGridStyle}>
          {agents.map(agent => (
            <div key={agent.id} style={agentEditCardStyle}>
              {/* Card Title Bar */}
              <div style={cardHeaderStyle}>
                <input 
                  type="text" 
                  value={agent.name} 
                  onChange={e => handleUpdateAgent(agent.id, { name: e.target.value })}
                  style={agentNameInputStyle}
                />
                <button 
                  onClick={() => handleRemoveAgent(agent.id)} 
                  style={btnDeleteStyle}
                  title="Remove Agent"
                >
                  <Trash size={12} />
                </button>
              </div>

              {/* Grid Form */}
              <div style={cardBodyStyle}>
                <div style={formRowStyle}>
                  <div className="flex-1">
                    <label style={labelStyle}>Role</label>
                    <select 
                      value={agent.role} 
                      onChange={e => handleUpdateAgent(agent.id, { role: e.target.value as AgentRole })}
                      style={selectStyle}
                    >
                      <option value="coordinator">Coordinator</option>
                      <option value="builder">Builder</option>
                      <option value="scout">Scout</option>
                      <option value="reviewer">Reviewer</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label style={labelStyle}>Provider</label>
                    <select
                      value={agent.provider || 'codex'}
                      onChange={e => handleUpdateAgent(agent.id, { provider: e.target.value as AgentProvider })}
                      style={selectStyle}
                    >
                      {[...PROVIDER_ORDER, 'custom' as AgentProvider].map(p => (
                        <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1">
                    <label style={labelStyle}>Model</label>
                    <ModelCombobox
                      provider={agent.provider || 'codex'}
                      value={agent.model}
                      onChange={model => handleUpdateAgent(agent.id, { model })}
                      style={inputStyle}
                    />
                  </div>
                </div>

                <div>
                  <label style={labelStyle}>System Instructions (Prompt)</label>
                  <textarea 
                    value={agent.systemPrompt} 
                    onChange={e => handleUpdateAgent(agent.id, { systemPrompt: e.target.value })}
                    style={textareaStyle}
                  />
                </div>

                {/* Dependencies checkboxes */}
                <div>
                  <label style={labelStyle}>Depends On (Requires first)</label>
                  <div style={depsGridStyle}>
                    {agents
                      .filter(a => a.id !== agent.id)
                      .map(otherAgent => {
                        const isDep = agent.dependencies.includes(otherAgent.id);
                        return (
                          <label key={otherAgent.id} style={checkboxLabelStyle}>
                            <input 
                              type="checkbox" 
                              checked={isDep} 
                              onChange={() => handleToggleDependency(agent.id, otherAgent.id)}
                            />
                            <span>{otherAgent.name}</span>
                          </label>
                        );
                      })}
                    {agents.length <= 1 && (
                      <span className="swarm-empty-hint">
                        No other agents to depend on.
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

/* --- Styles --- */

const containerStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '24px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid var(--border)',
  paddingBottom: '16px',
};

const btnPrimaryStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 14px',
  fontSize: '12px',
  height: '32px',
};

const btnSecondaryStyle: React.CSSProperties = {
  padding: '6px 14px',
  fontSize: '12px',
  height: '32px',
  backgroundColor: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const errorBannerStyle: React.CSSProperties = {
  backgroundColor: 'rgba(239, 68, 68, 0.1)',
  color: 'var(--color-danger)',
  border: '1px solid rgba(239, 68, 68, 0.2)',
  padding: '12px 16px',
  borderRadius: 'var(--radius-md)',
  fontSize: '12px',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const editorFormStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '18px',
};

const formRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-muted)',
  marginBottom: '6px',
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: '32px',
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '0 10px',
  fontSize: '12.5px',
};

const selectStyle: React.CSSProperties = {
  width: '100%',
  height: '32px',
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '0 10px',
  fontSize: '12.5px',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: '60px',
  backgroundColor: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  padding: '8px 10px',
  fontSize: '12.5px',
  resize: 'vertical',
  lineHeight: '1.45',
};

const agentsSectionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginTop: '12px',
  borderBottom: '1px solid var(--border)',
  paddingBottom: '8px',
};

const btnAddAgentStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '0 10px',
  height: '24px',
  fontSize: '11px',
  backgroundColor: 'rgba(99, 102, 241, 0.1)',
  color: 'var(--accent)',
  border: '1px solid rgba(99, 102, 241, 0.2)',
  borderRadius: '3px',
  cursor: 'pointer',
};

const agentsGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
  gap: '16px',
};

const agentEditCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-app)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid rgba(255, 255, 255, 0.05)',
  paddingBottom: '10px',
};

const agentNameInputStyle: React.CSSProperties = {
  backgroundColor: 'transparent',
  border: 'none',
  borderBottom: '1px dashed var(--border)',
  color: 'var(--text-primary)',
  fontWeight: 600,
  fontSize: '13px',
  padding: '2px 0',
  width: '80%',
};

const btnDeleteStyle: React.CSSProperties = {
  padding: '4px',
  backgroundColor: 'transparent',
  border: 'none',
  color: 'var(--text-muted)',
  cursor: 'pointer',
};

const cardBodyStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
};

const depsGridStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '10px',
  backgroundColor: 'var(--bg-deep)',
  padding: '8px 10px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--border)',
};

const checkboxLabelStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '11.5px',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
};
