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
        <h2 style={heroTitleStyle}>Build your <span style={{ color: 'var(--accent)' }}>roster</span></h2>
        <p style={heroSubtitleStyle}>Pick a preset or customize individual agents. This is the team that will ship your code.</p>
      </div>

      {/* Quick presets */}
      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>Quick Presets</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '10px' }}>
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
                <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{p.label}</span>
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
              {EXPERIMENTAL_PROVIDERS.has(p) && <Zap size={11} style={{ color: 'var(--color-warning)' }} />}
              {PROVIDER_LABELS[p]}
            </button>
          ))}
        </div>
      </div>

      {/* Composition summary */}
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
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
        <span style={{ marginLeft: 'auto', fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>{agents.length} total</span>
      </div>

      {/* Agent list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
        onClick={addAgent}
        style={{
          marginTop: '10px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
          height: '36px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)',
          background: 'transparent', color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
        }}
      >
        <Plus size={13} /> Add Agent
      </button>

      {/* Advanced: start from template */}
      <div style={{ marginTop: '20px', borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
        <button
          onClick={() => setShowTemplates((v) => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px', background: 'transparent', border: 'none',
            color: 'var(--text-secondary)', fontSize: '12px', fontWeight: 600, cursor: 'pointer', padding: 0,
          }}
        >
          {showTemplates ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Advanced: start from a named template
        </button>
        {showTemplates && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px', marginTop: '12px' }}>
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
                <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)' }}>{t.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.4 }}>{t.description}</div>
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
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--bg-surface-light)', overflow: 'hidden' }}>
      {/* Collapsed header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px' }}>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', width: '18px' }}>{index + 1}</span>
        <span style={{ color: accent, display: 'inline-flex' }}>{roleIcon(agent.role)}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {agent.name}
          </div>
          <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
            {PROVIDER_LABELS[agent.provider || 'codex']} · {agent.autoApprove ? <span style={{ color: 'var(--color-warning)' }}>Auto</span> : 'Manual'}
          </div>
        </div>
        <button onClick={onRemove} title="Remove agent" style={iconBtn}><Trash2 size={13} /></button>
        <button onClick={onToggleExpand} style={iconBtn}>{agent.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
      </div>

      {agent.expanded && (
        <div style={{ borderTop: '1px solid var(--border)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
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
                  {EXPERIMENTAL_PROVIDERS.has(p) && <Zap size={11} style={{ color: 'var(--color-warning)' }} />}
                  {PROVIDER_LABELS[p]}
                </button>
              ))}
            </div>
          </div>

          {/* Model + auto-approve */}
          <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
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
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {allAgents.filter((a) => a.id !== agent.id).map((other) => {
                const isDep = agent.dependencies.includes(other.id);
                return (
                  <button key={other.id} onClick={() => onToggleDependency(other.id)} style={chipStyle(isDep)}>
                    {isDep && <Check size={11} />} {other.name}
                  </button>
                );
              })}
              {allAgents.length <= 1 && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic' }}>No other agents to depend on.</span>
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
