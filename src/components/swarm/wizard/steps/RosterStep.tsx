import React, { useState } from 'react';
import {
  Users, Crown, Wrench, Search, Eye, Plus, Trash2, ChevronDown, ChevronRight, Check, Zap,
} from 'lucide-react';
import type { WizardStepProps, WizardAgent } from '../../../../types/wizard';
import type { AgentRole } from '../../../../types/agent';
import type { AgentProvider } from '../../../../types/provider';
import { useSwarmStore } from '../../../../stores/swarmStore';
import { createId } from '../../../../lib/id';
import {
  SIZE_PRESETS, generateRoster, ROLE_LABELS, ROLE_COLORS, ROLE_ORDER, composeComposition,
} from '../constants';
import { PROVIDER_ORDER, PROVIDER_LABELS, PROVIDER_DEFAULT_MODEL, EXPERIMENTAL_PROVIDERS } from '../providerMeta';
import {
  heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionStyle, sectionLabelStyle,
  chipRowStyle, chipStyle,
} from '../wizardStyles';

const roleIcon = (role: AgentRole, size = 14) => {
  switch (role) {
    case 'coordinator': return <Crown size={size} />;
    case 'builder': return <Wrench size={size} />;
    case 'scout': return <Search size={size} />;
    case 'reviewer': return <Eye size={size} />;
    default: return <Wrench size={size} />;
  }
};

export const RosterStep: React.FC<WizardStepProps> = ({ state, update }) => {
  const templates = useSwarmStore((s) => s.templates);
  const [showTemplates, setShowTemplates] = useState(false);

  const { agents, globalProvider, sizePresetId, startedFromTemplateId } = state;

  const selectPreset = (presetId: typeof SIZE_PRESETS[number]['id']) => {
    const preset = SIZE_PRESETS.find((p) => p.id === presetId)!;
    update({ sizePresetId: preset.id, agents: generateRoster(preset, globalProvider), startedFromTemplateId: null });
  };

  const selectGlobalProvider = (provider: AgentProvider) => {
    update({
      globalProvider: provider,
      agents: agents.map((a) => ({ ...a, provider, model: PROVIDER_DEFAULT_MODEL[provider] || 'default' })),
    });
  };

  const patchAgent = (id: string, patch: Partial<WizardAgent>) =>
    update({ agents: agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) });

  const removeAgent = (id: string) =>
    update({
      agents: agents
        .filter((a) => a.id !== id)
        .map((a) => ({ ...a, dependencies: a.dependencies.filter((d) => d !== id) })),
    });

  const addAgent = () =>
    update({
      sizePresetId: null,
      agents: [
        ...agents,
        {
          id: createId('agent'),
          name: `${ROLE_LABELS.builder} ${agents.filter((a) => a.role === 'builder').length + 1}`,
          role: 'builder',
          provider: globalProvider,
          model: PROVIDER_DEFAULT_MODEL[globalProvider] || 'default',
          systemPrompt: 'You are a helpful coding agent.',
          dependencies: [],
          autoApprove: false,
          expanded: true,
        },
      ],
    });

  const toggleDependency = (agentId: string, depId: string) =>
    update({
      agents: agents.map((a) => {
        if (a.id !== agentId) return a;
        const deps = a.dependencies.includes(depId)
          ? a.dependencies.filter((d) => d !== depId)
          : [...a.dependencies, depId];
        return { ...a, dependencies: deps };
      }),
    });

  const startFromTemplate = (templateId: string) => {
    const tpl = templates.find((t) => t.id === templateId);
    if (!tpl) return;
    update({
      startedFromTemplateId: tpl.id,
      sizePresetId: null,
      agents: tpl.agents.map((a) => ({ ...a, autoApprove: false })),
    });
  };

  const composition = composeComposition(agents);

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><Users size={26} /></div>
        <h2 style={heroTitleStyle}>Build your <span className="extracted-style-214">roster</span></h2>
        <p style={heroSubtitleStyle}>Pick a preset or customize individual agents. This is the team that will ship your code.</p>
      </div>

      {/* Quick presets */}
      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>Quick Presets</div>
        <div className="extracted-style-215">
          {SIZE_PRESETS.map((p) => {
            const selected = sizePresetId === p.id;
            return (
              <button
                key={p.id}
                onClick={() => selectPreset(p.id)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', padding: '14px 8px',
                  borderRadius: 'var(--radius-md)', cursor: 'pointer',
                  border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected ? 'var(--accent-light)' : 'var(--bg-surface-light)',
                }}
              >
                <span style={{ fontSize: '22px', fontWeight: 700, color: selected ? 'var(--accent)' : 'var(--text-primary)' }}>{p.count}</span>
                <span className="extracted-style-216">{p.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* CLI agent for all */}
      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>CLI Agent for All</div>
        <div style={chipRowStyle}>
          {PROVIDER_ORDER.map((p) => (
            <button key={p} onClick={() => selectGlobalProvider(p)} style={chipStyle(globalProvider === p)}>
              {EXPERIMENTAL_PROVIDERS.has(p) && <Zap size={11} className="extracted-style-217" />}
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Composition summary */}
      <div className="extracted-style-218">
        {composition.map((c) => (
          <span
            key={c.role}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 9px', borderRadius: 'var(--radius-full)',
              fontSize: '11px', fontWeight: 600, color: ROLE_COLORS[c.role],
              background: 'var(--bg-surface-light)', border: `1px solid var(--border)`,
            }}
          >
            {roleIcon(c.role, 12)} {c.count} {ROLE_LABELS[c.role]}{c.count > 1 ? 's' : ''}
          </span>
        ))}
        <span className="extracted-style-219">{agents.length} total</span>
      </div>

      {/* Agent list */}
      <div className="extracted-style-220">
        {agents.map((agent, idx) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            index={idx}
            allAgents={agents}
            onToggleExpand={() => patchAgent(agent.id, { expanded: !agent.expanded })}
            onPatch={(patch) => patchAgent(agent.id, patch)}
            onRemove={() => removeAgent(agent.id)}
            onToggleDependency={(depId) => toggleDependency(agent.id, depId)}
          />
        ))}
      </div>

      <button
        onClick={addAgent} className="extracted-style-221"
      >
        <Plus size={13} /> Add Agent
      </button>

      {/* Advanced: start from template */}
      <div className="extracted-style-222">
        <button
          onClick={() => setShowTemplates((v) => !v)} className="extracted-style-223"
        >
          {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Advanced: start from a named template
        </button>
        {showTemplates && (
          <div className="extracted-style-224">
            {templates.map((t) => (
              <button
                key={t.id}
                onClick={() => startFromTemplate(t.id)}
                style={{
                  textAlign: 'left', padding: '12px', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                  border: `1px solid ${startedFromTemplateId === t.id ? 'var(--accent)' : 'var(--border)'}`,
                  background: startedFromTemplateId === t.id ? 'var(--accent-light)' : 'var(--bg-surface-light)',
                }}
              >
                <div className="extracted-style-225">{t.name}</div>
                <div className="extracted-style-226">{t.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

interface AgentRowProps {
  agent: WizardAgent;
  index: number;
  allAgents: WizardAgent[];
  onToggleExpand: () => void;
  onPatch: (patch: Partial<WizardAgent>) => void;
  onRemove: () => void;
  onToggleDependency: (depId: string) => void;
}

const AgentRow: React.FC<AgentRowProps> = ({ agent, index, allAgents, onToggleExpand, onPatch, onRemove, onToggleDependency }) => {
  const accent = ROLE_COLORS[agent.role];
  return (
    <div className="extracted-style-227">
      {/* Collapsed header row */}
      <div className="extracted-style-228">
        <span className="extracted-style-229">{index + 1}</span>
        <span style={{ color: accent, display: 'inline-flex' }}>{roleIcon(agent.role)}</span>
        <div className="extracted-style-230">
          <div className="extracted-style-231">
            {agent.name}
          </div>
          <div className="extracted-style-232">
            {PROVIDER_LABELS[agent.provider || 'codex']} · {agent.autoApprove ? <span className="extracted-style-233">Auto</span> : 'Manual'}
          </div>
        </div>
        <button onClick={onRemove} title="Remove agent" style={iconBtn}><Trash2 size={13} /></button>
        <button onClick={onToggleExpand} style={iconBtn}>{agent.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      </div>

      {agent.expanded && (
        <div className="extracted-style-234">
          {/* Name */}
          <div>
            <div style={sectionLabelStyle}>Name</div>
            <input value={agent.name} onChange={(e) => onPatch({ name: e.target.value })} style={smallInput} />
          </div>

          {/* Role chips */}
          <div>
            <div style={sectionLabelStyle}>Role</div>
            <div style={chipRowStyle}>
              {ROLE_ORDER.map((r) => (
                <button key={r} onClick={() => onPatch({ role: r })} style={chipStyle(agent.role === r, ROLE_COLORS[r])}>
                  {roleIcon(r, 12)} {ROLE_LABELS[r]}
                </button>
              ))}
            </div>
          </div>

          {/* Provider chips */}
          <div>
            <div style={sectionLabelStyle}>CLI</div>
            <div style={chipRowStyle}>
              {PROVIDER_ORDER.map((p) => (
                <button
                  key={p}
                  onClick={() => onPatch({ provider: p, model: PROVIDER_DEFAULT_MODEL[p] || 'default' })}
                  style={chipStyle((agent.provider || 'codex') === p)}
                >
                  {EXPERIMENTAL_PROVIDERS.has(p) && <Zap size={11} className="extracted-style-235" />}
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Model + auto-approve */}
          <div className="extracted-style-236">
            <div className="extracted-style-237">
              <div style={sectionLabelStyle}>Model</div>
              <input value={agent.model} onChange={(e) => onPatch({ model: e.target.value })} style={smallInput} />
            </div>
            <button
              onClick={() => onPatch({ autoApprove: !agent.autoApprove })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: '6px', height: '34px', padding: '0 12px',
                borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '12px', fontWeight: 600,
                border: `1px solid ${agent.autoApprove ? 'var(--color-warning)' : 'var(--border)'}`,
                background: agent.autoApprove ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-surface)',
                color: agent.autoApprove ? 'var(--color-warning)' : 'var(--text-secondary)',
              }}
            >
              {agent.autoApprove && <Check size={13} />} Auto-approve
            </button>
          </div>

          {/* System prompt */}
          <div>
            <div style={sectionLabelStyle}>System Instructions</div>
            <textarea
              value={agent.systemPrompt}
              onChange={(e) => onPatch({ systemPrompt: e.target.value })}
              style={{ ...smallInput, height: 'auto', minHeight: '64px', padding: '8px 10px', lineHeight: 1.45, resize: 'vertical' }}
            />
          </div>

          {/* Dependencies */}
          <div>
            <div style={sectionLabelStyle}>Depends On (runs after)</div>
            <div className="extracted-style-238">
              {allAgents.filter((a) => a.id !== agent.id).map((other) => {
                const isDep = agent.dependencies.includes(other.id);
                return (
                  <button key={other.id} onClick={() => onToggleDependency(other.id)} style={chipStyle(isDep)}>
                    {isDep && <Check size={11} />} {other.name}
                  </button>
                );
              })}
              {allAgents.length <= 1 && (
                <span className="extracted-style-239">No other agents to depend on.</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
  padding: '4px', display: 'inline-flex', alignItems: 'center',
};

const smallInput: React.CSSProperties = {
  width: '100%', height: '32px', background: 'var(--bg-deep)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', padding: '0 10px', fontSize: '12.5px',
};
