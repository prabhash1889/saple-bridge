import React, { useEffect, useMemo } from 'react';
import { Rocket, Check, AlertTriangle, Zap, FileText } from 'lucide-react';
import type { WizardStepProps } from '../../../../types/wizard';
import type { AgentProvider } from '../../../../types/provider';
import { useProviderStore } from '../../../../stores/providerStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { PROVIDER_LABELS, EXPERIMENTAL_PROVIDERS } from '../providerMeta';
import { ROLE_LABELS, ROLE_COLORS } from '../constants';
import { getSkillById } from '../skills';
import { heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionLabelStyle, warningBannerStyle } from '../wizardStyles';

export const LaunchStep: React.FC<WizardStepProps> = ({ state }) => {
  const { swarmName, directory, mission, agents, skills, contextFiles } = state;
  const providers = useProviderStore((s) => s.providers);
  const refreshReadiness = useProviderStore((s) => s.refreshReadiness);
  const maxParallel = useProjectStore((s) => s.workspaceConfig?.maxParallelAgents) ?? 12;

  useEffect(() => { void refreshReadiness(); }, [refreshReadiness]);

  // Derive readiness from the live providers list so this re-renders on refresh.
  const isReady = (p: AgentProvider): boolean => {
    const entry = providers.find((x) => x.provider === p);
    if (!entry) return false;
    if (p === 'custom') return entry.enabled;
    return entry.authenticated === true && entry.enabled;
  };

  const distinctProviders = useMemo(
    () => Array.from(new Set(agents.map((a) => (a.provider || 'codex') as AgentProvider))),
    [agents],
  );

  const unready = distinctProviders.filter((p) => !isReady(p) && !EXPERIMENTAL_PROVIDERS.has(p));
  const experimentalInUse = distinctProviders.filter((p) => EXPERIMENTAL_PROVIDERS.has(p));

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><Rocket size={24} /></div>
        <h2 style={heroTitleStyle}>Review &amp; <span style={{ color: 'var(--accent)' }}>launch</span></h2>
        <p style={heroSubtitleStyle}>Confirm the setup below, then launch the swarm. Agents start as soon as their dependencies allow.</p>
      </div>

      {unready.length > 0 && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} style={{ marginTop: '1px', flexShrink: 0 }} />
          <span>
            No stored credentials for {unready.map((p) => PROVIDER_LABELS[p]).join(', ')}. Those agents may still work if the CLI is logged in, otherwise they could fail.
          </span>
        </div>
      )}
      {experimentalInUse.length > 0 && (
        <div style={warningBannerStyle}>
          <Zap size={14} style={{ marginTop: '1px', flexShrink: 0 }} />
          <span>{experimentalInUse.map((p) => PROVIDER_LABELS[p]).join(', ')} are experimental and launch interactively (no prompt is piped in).</span>
        </div>
      )}
      {agents.length > maxParallel && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} style={{ marginTop: '1px', flexShrink: 0 }} />
          <span>This roster has {agents.length} agents, above the workspace's parallel limit ({maxParallel}). Dependency ordering usually keeps fewer running at once — raise Max Parallel Agents in settings if needed.</span>
        </div>
      )}

      {/* Summary fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <Field label="Name" value={swarmName || '—'} />
        <Field label="Directory" value={directory || '—'} mono />
        <div>
          <div style={sectionLabelStyle}>Mission</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{mission || '—'}</div>
        </div>

        {/* Roster */}
        <div>
          <div style={sectionLabelStyle}>Roster ({agents.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {agents.map((a) => {
              const provider = (a.provider || 'codex') as AgentProvider;
              const ready = isReady(provider) || EXPERIMENTAL_PROVIDERS.has(provider);
              return (
                <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '12px', padding: '6px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-light)', border: '1px solid var(--border)' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: ROLE_COLORS[a.role], flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--text-primary)', fontWeight: 600 }}>{a.name}</span>
                  <span style={{ color: 'var(--text-muted)' }}>{ROLE_LABELS[a.role]}</span>
                  <span style={{ color: 'var(--text-secondary)' }}>{PROVIDER_LABELS[provider]}</span>
                  {a.autoApprove && <span style={{ color: 'var(--color-warning)', fontSize: '10.5px', fontWeight: 700 }}>AUTO</span>}
                  {ready
                    ? <Check size={13} style={{ color: 'var(--color-success)' }} />
                    : <AlertTriangle size={13} style={{ color: 'var(--color-warning)' }} />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <div style={sectionLabelStyle}>Skills</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {skills.map((id) => (
                <span key={id} style={{ fontSize: '11px', padding: '3px 9px', borderRadius: 'var(--radius-full)', background: 'var(--accent-light)', color: 'var(--accent)', fontWeight: 600 }}>
                  {getSkillById(id)?.label || id}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Context files */}
        {contextFiles.length > 0 && (
          <div>
            <div style={sectionLabelStyle}>Context Files ({contextFiles.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
              {contextFiles.map((f) => (
                <span key={f.name} style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                  <FileText size={12} style={{ color: 'var(--text-muted)' }} /> {f.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div>
    <div style={sectionLabelStyle}>{label}</div>
    <div style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600, wordBreak: 'break-all', fontFamily: mono ? 'var(--font-mono, monospace)' : undefined }}>{value}</div>
  </div>
);
