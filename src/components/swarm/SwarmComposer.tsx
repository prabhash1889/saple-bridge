import React, { useRef, useState } from 'react';
import { Rocket, X, AlertCircle } from 'lucide-react';
import type { AgentProvider } from '../../types/provider';
import type { AutonomyMode } from '../../types/swarmPlan';
import { useSwarmStore } from '../../stores/swarmStore';
import { PROVIDER_LABELS, PROVIDER_ORDER } from './wizard/providerMeta';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface SwarmComposerProps {
  projectPath: string | null;
  onClose: () => void;
  initialMission?: string;
}

const AUTONOMY_OPTIONS: { value: AutonomyMode; label: string; hint: string }[] = [
  { value: 'manual', label: 'Manual', hint: 'every transition needs a human click' },
  { value: 'gated', label: 'Gated', hint: 'auto-rework, human approves the plan (default)' },
  { value: 'auto', label: 'Auto', hint: 'hands-free within budgets' },
];

// Mission-first launch (Phase 2). Replaces the wizard DAG: the operator writes a mission and the
// coordinator's plan.json materializes the workers. A minimal interim surface until the Phase 7
// launch composer; deliberately just mission + a few knobs.
export const SwarmComposer: React.FC<SwarmComposerProps> = ({ projectPath, onClose, initialMission }) => {
  const [mission, setMission] = useState(initialMission ?? '');
  const [provider, setProvider] = useState<AgentProvider>('codex');
  const [autonomy, setAutonomy] = useState<AutonomyMode>('gated');
  const [maxParallel, setMaxParallel] = useState(4);
  const [maxWaves, setMaxWaves] = useState(3);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

  const handleLaunch = async () => {
    if (!projectPath) { setError('Open a workspace first.'); return; }
    if (!mission.trim()) { setError('Describe the mission.'); return; }
    setLaunching(true);
    setError(null);
    try {
      await useSwarmStore.getState().startSwarm(projectPath, mission.trim(), {
        autonomy,
        maxParallel: Math.max(1, maxParallel),
        maxWaves: Math.max(1, maxWaves),
        provider,
      });
      onClose();
    } catch (e) {
      setError(`Failed to launch swarm: ${e}`);
      setLaunching(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="modal-container"
        style={containerStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="swarm-composer-title"
        tabIndex={-1}
      >
        <div style={headerStyle}>
          <span id="swarm-composer-title" className="swarm-strong">Create Swarm</span>
          <button onClick={onClose} style={closeBtnStyle} title="Close" aria-label="Close swarm composer"><X size={16} /></button>
        </div>

        <div style={bodyStyle}>
          {error && (
            <div style={errorBannerStyle}><AlertCircle size={14} /><span>{error}</span></div>
          )}

          <label style={fieldStyle}>
            <span style={labelStyle}>Mission</span>
            <textarea
              value={mission}
              onChange={(e) => setMission(e.target.value)}
              placeholder="Describe what the swarm should accomplish. The coordinator plans the tasks."
              rows={5}
              style={textareaStyle}
              autoFocus
            />
          </label>

          <label style={fieldStyle}>
            <span style={labelStyle}>Coordinator CLI</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as AgentProvider)} style={selectStyle}>
              {PROVIDER_ORDER.map((p) => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </label>

          <fieldset style={autonomyFieldsetStyle}>
            <span style={labelStyle}>Autonomy</span>
            <div style={autonomyRowStyle}>
              {AUTONOMY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setAutonomy(o.value)}
                  style={autonomyChipStyle(autonomy === o.value)}
                  title={o.hint}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span style={hintStyle}>{AUTONOMY_OPTIONS.find((o) => o.value === autonomy)?.hint}</span>
          </fieldset>

          <div style={numbersRowStyle}>
            <label style={fieldStyle}>
              <span style={labelStyle}>Max parallel agents</span>
              <input
                type="number"
                min={1}
                value={maxParallel}
                onChange={(e) => setMaxParallel(Number(e.target.value) || 1)}
                style={numberInputStyle}
              />
            </label>
            <label style={fieldStyle}>
              <span style={labelStyle}>Max repair waves</span>
              <input
                type="number"
                min={1}
                value={maxWaves}
                onChange={(e) => setMaxWaves(Number(e.target.value) || 1)}
                style={numberInputStyle}
              />
            </label>
          </div>
        </div>

        <div style={footerStyle}>
          <button onClick={onClose} style={ghostBtnStyle}>Cancel</button>
          <button
            onClick={handleLaunch}
            className="primary"
            style={primaryBtnStyle}
            disabled={launching || !mission.trim() || !projectPath}
          >
            <Rocket size={14} /> {launching ? 'Launching…' : 'Launch Swarm'}
          </button>
        </div>
      </div>
    </div>
  );
};

/* --- styles --- */

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '92%',
  maxWidth: '560px',
  maxHeight: '88vh',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '14px 20px',
  borderBottom: '1px solid var(--border)',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
  display: 'inline-flex', padding: '4px',
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '20px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
};

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  flex: 1,
};

const labelStyle: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  resize: 'vertical',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px 12px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
};

const selectStyle: React.CSSProperties = {
  height: '34px',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 10px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  outline: 'none',
};

const autonomyFieldsetStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  border: 'none',
  margin: 0,
  padding: 0,
};

const autonomyRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '8px',
};

const autonomyChipStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  height: '34px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  borderRadius: 'var(--radius-sm)',
  border: `1px solid ${active ? 'rgba(93, 95, 239, 0.65)' : 'var(--border)'}`,
  background: active ? 'var(--accent-light)' : 'transparent',
  color: active ? 'var(--text-primary)' : 'var(--text-muted)',
});

const hintStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-muted)',
};

const numbersRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
};

const numberInputStyle: React.CSSProperties = {
  height: '34px',
  background: 'var(--bg-deep)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 10px',
  color: 'var(--text-primary)',
  fontSize: '13px',
  outline: 'none',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '10px',
  padding: '14px 20px',
  borderTop: '1px solid var(--border)',
  background: 'var(--bg-surface)',
};

const ghostBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  height: '34px',
  padding: '0 14px',
  fontSize: '12px',
  background: 'transparent',
  border: '1px solid var(--border)',
  color: 'var(--text-secondary)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '34px',
  padding: '0 16px',
  fontSize: '12px',
  fontWeight: 600,
};

const errorBannerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 12px',
  borderRadius: 'var(--radius-sm)',
  border: '1px solid rgba(239, 68, 68, 0.3)',
  background: 'rgba(239, 68, 68, 0.1)',
  color: 'var(--color-danger)',
  fontSize: '12px',
};
