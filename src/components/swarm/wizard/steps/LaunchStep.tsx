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
        <h2 style={heroTitleStyle}>Review &amp; <span className="extracted-style-183">launch</span></h2>
        <p style={heroSubtitleStyle}>Confirm the setup below, then launch the swarm. Agents start as soon as their dependencies allow.</p>
      </div>

      {unready.length > 0 && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} className="extracted-style-184" />
          <span>
            No stored credentials for {unready.map((p) => PROVIDER_LABELS[p]).join(', ')}. Those agents may still work if the CLI is logged in, otherwise they could fail.
          </span>
        </div>
      )}
      {experimentalInUse.length > 0 && (
        <div style={warningBannerStyle}>
          <Zap size={14} className="extracted-style-185" />
          <span>{experimentalInUse.map((p) => PROVIDER_LABELS[p]).join(', ')} are experimental and launch interactively (no prompt is piped in).</span>
        </div>
      )}
      {agents.length > maxParallel && (
        <div style={warningBannerStyle}>
          <AlertTriangle size={14} className="extracted-style-186" />
          <span>This roster has {agents.length} agents, above the workspace's parallel limit ({maxParallel}). Dependency ordering usually keeps fewer running at once — raise Max Parallel Agents in settings if needed.</span>
        </div>
      )}

      {/* Summary fields */}
      <div className="extracted-style-187">
        <Field label="Name" value={swarmName || '—'} />
        <Field label="Directory" value={directory || '—'} mono />
        <div>
          <div style={sectionLabelStyle}>Mission</div>
          <div className="extracted-style-188">{mission || '—'}</div>
        </div>

        {/* Roster */}
        <div>
          <div style={sectionLabelStyle}>Roster ({agents.length})</div>
          <div className="extracted-style-189">
            {agents.map((a) => {
              const provider = (a.provider || 'codex') as AgentProvider;
              const ready = isReady(provider) || EXPERIMENTAL_PROVIDERS.has(provider);
              return (
                <div key={a.id} className="extracted-style-190">
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: ROLE_COLORS[a.role], flexShrink: 0 }} />
                  <span className="extracted-style-191">{a.name}</span>
                  <span className="extracted-style-192">{ROLE_LABELS[a.role]}</span>
                  <span className="extracted-style-193">{PROVIDER_LABELS[provider]}</span>
                  {a.autoApprove && <span className="extracted-style-194">AUTO</span>}
                  {ready
                    ? <Check size={13} className="extracted-style-195" />
                    : <AlertTriangle size={13} className="extracted-style-196" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Skills */}
        {skills.length > 0 && (
          <div>
            <div style={sectionLabelStyle}>Skills</div>
            <div className="extracted-style-197">
              {skills.map((id) => (
                <span key={id} className="extracted-style-198">
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
            <div className="extracted-style-199">
              {contextFiles.map((f) => (
                <span key={f.name} className="extracted-style-200">
                  <FileText size={12} className="extracted-style-201" /> {f.name}
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
