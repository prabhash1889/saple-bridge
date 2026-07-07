import React, { useEffect, useMemo } from 'react';
import { Rocket, Check, AlertTriangle, Zap, FileText } from 'lucide-react';
import type { WizardStepProps } from '../../../../types/wizard';
import type { AgentProvider } from '../../../../types/provider';
import { useProviderStore } from '../../../../stores/providerStore';
import { useProjectStore } from '../../../../stores/projectStore';
import { PROVIDER_LABELS, EXPERIMENTAL_PROVIDERS } from '../providerMeta';
import { ROLE_LABELS, ROLE_COLORS } from '../constants';
import { getSkillById } from '../skills';
import { heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionLabelStyle, warningBannerStyle, errorBannerStyle } from '../wizardStyles';

export const LaunchStep: React.FC<WizardStepProps> = ({ state }) => {
  const { swarmName, directory, mission, agents, skills, contextFiles } = state;
  const providers = useProviderStore((s) => s.providers);
  const refreshReadiness = useProviderStore((s) => s.refreshReadiness);
  const maxParallel = useProjectStore((s) => s.workspaceConfig?.maxParallelAgents) ?? 12;

  useEffect(() => { void refreshReadiness(); }, [refreshReadiness]);

  // Derive readiness from the live providers list so this re-renders on refresh. A CLI
  // sign-in (subscription/OAuth login) counts the same as a stored API key — mirroring
  // providerStore.isReady — so a `claude`/`codex` login doesn't warn about "no credentials".
  const isReady = (p: AgentProvider): boolean => {
    const entry = providers.find((x) => x.provider === p);
    if (!entry) return false;
    if (p === 'custom') return entry.enabled;
    return (entry.authenticated === true || entry.signedIn === true) && entry.enabled;
  };

  const distinctProviders = useMemo(
    () => Array.from(new Set(agents.map((a) => (a.provider || 'codex') as AgentProvider))),
    [agents],
  );

  const unready = distinctProviders.filter((p) => !isReady(p) && !EXPERIMENTAL_PROVIDERS.has(p));
  const experimentalInUse = distinctProviders.filter((p) => EXPERIMENTAL_PROVIDERS.has(p));
  // CLI definitively not on PATH (check ran and failed). These block launch — a missing
  // binary can never work, and today it just produces instantly-failed agents.
  const missingClis = distinctProviders.filter(
    (p) => providers.find((x) => x.provider === p)?.installed === false,
  );

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><Rocket size={24} /></div>
        <h2 style={heroTitleStyle}>Review &amp; <span className="fg-accent">launch</span></h2>
        <p style={heroSubtitleStyle}>Confirm the setup below, then launch the swarm. Agents start as soon as their dependencies allow.</p>
      </div>

      {missingClis.length > 0 && (
        <div style={errorBannerStyle}>
          <AlertTriangle size={14} className="swarm-inline-icon" />
          <span>
            CLI not installed for {missingClis.map((p) => PROVIDER_LABELS[p]).join(', ')}. Launch is blocked — install the CLI or switch those agents to another provider in the Roster step.
          </span>
        </div>
      )}
      {unready.length > 0 && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} className="swarm-inline-icon" />
          <span>
            No stored credentials for {unready.map((p) => PROVIDER_LABELS[p]).join(', ')}. Those agents may still work if the CLI is logged in, otherwise they could fail.
          </span>
        </div>
      )}
      {experimentalInUse.length > 0 && (
        <div style={warningBannerStyle}>
          <Zap size={14} className="swarm-inline-icon" />
          <span>{experimentalInUse.map((p) => PROVIDER_LABELS[p]).join(', ')} are experimental and launch interactively (no prompt is piped in).</span>
        </div>
      )}
      {agents.length > maxParallel && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} className="swarm-inline-icon" />
          <span>This roster has {agents.length} agents, above the workspace's parallel limit ({maxParallel}). Dependency ordering usually keeps fewer running at once — raise Max Parallel Agents in settings if needed.</span>
        </div>
      )}

      {/* Summary fields */}
      <div className="swarm-detail-col">
        <Field label="Name" value={swarmName || '—'} />
        <Field label="Directory" value={directory || '—'} mono />
        <div>
          <div style={sectionLabelStyle}>Mission</div>
          <div className="swarm-detail-text">{mission || '—'}</div>
        </div>

        {/* Roster */}
        <div>
          <div style={sectionLabelStyle}>Roster ({agents.length})</div>
          <div className="swarm-detail-list">
            {agents.map((a) => {
              const provider = (a.provider || 'codex') as AgentProvider;
              const ready = isReady(provider) || EXPERIMENTAL_PROVIDERS.has(provider);
              return (
                <div key={a.id} className="swarm-detail-row">
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: ROLE_COLORS[a.role], flexShrink: 0 }} />
                  <span className="swarm-detail-row-label">{a.name}</span>
                  <span className="fg-muted">{ROLE_LABELS[a.role]}</span>
                  <span className="fg-secondary">{PROVIDER_LABELS[provider]}</span>
                  {a.autoApprove && <span className="swarm-detail-badge-warn">AUTO</span>}
                  {ready
                    ? <Check size={13} className="fg-success" />
                    : <AlertTriangle size={13} className="fg-warning" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <div style={sectionLabelStyle}>Skills</div>
            <div className="swarm-chip-wrap">
              {skills.map((id) => (
                <span key={id} className="swarm-chip">
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
            <div className="swarm-stat-wrap">
              {contextFiles.map((f) => (
                <span key={f.name} className="swarm-stat">
                  <FileText size={12} className="fg-muted" /> {f.name}
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
