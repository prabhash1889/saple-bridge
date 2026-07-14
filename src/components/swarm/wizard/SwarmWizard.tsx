import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Users, MessageSquare, FolderOpen, FileText, Tag, Rocket, Check, AlertCircle, X, ChevronLeft, ChevronRight,
} from 'lucide-react';
import type { WizardState, WizardStepProps } from '../../../types/wizard';
import type { AgentProvider } from '../../../types/provider';
import { useSwarmStore } from '../../../stores/swarmStore';
import { useProviderStore } from '../../../stores/providerStore';
import { SIZE_PRESETS, generateRoster, hasDependencyCycle } from './constants';
import { PROVIDER_LABELS } from './providerMeta';
import { errorBannerStyle } from './wizardStyles';
import { RosterStep } from './steps/RosterStep';
import { MissionStep } from './steps/MissionStep';
import { DirectoryStep } from './steps/DirectoryStep';
import { ContextStep } from './steps/ContextStep';
import { NameStep } from './steps/NameStep';
import { LaunchStep } from './steps/LaunchStep';
import { useFocusTrap } from '../../../lib/useFocusTrap';

interface SwarmWizardProps {
  projectPath: string | null;
  onClose: () => void;
  // Template to seed the roster with (from the Swarm room's template picker). The user can
  // still switch presets/templates freely inside the Roster step.
  initialTemplateId?: string | null;
  // Mission text to pre-fill (from the Command Palette composer's "New swarm" target).
  initialMission?: string;
}

const STEPS = [
  { key: 'roster', label: 'Roster', icon: Users },
  { key: 'mission', label: 'Mission', icon: MessageSquare },
  { key: 'directory', label: 'Directory', icon: FolderOpen },
  { key: 'context', label: 'Context', icon: FileText },
  { key: 'name', label: 'Name', icon: Tag },
  { key: 'launch', label: 'Launch', icon: Rocket },
] as const;

export const SwarmWizard: React.FC<SwarmWizardProps> = ({ projectPath, onClose, initialTemplateId, initialMission }) => {
  const [state, setState] = useState<WizardState>(() => {
    const template = initialTemplateId
      ? useSwarmStore.getState().templates.find((t) => t.id === initialTemplateId)
      : undefined;
    return {
      step: 0,
      sizePresetId: template ? null : 'squad',
      globalProvider: 'claude',
      agents: template
        ? template.agents.map((a) => ({ ...a, autoApprove: false }))
        : generateRoster(SIZE_PRESETS[0], 'claude'),
      startedFromTemplateId: template?.id ?? null,
      mission: initialMission ?? '',
      skills: [],
      directory: projectPath || '',
      contextFiles: [],
      swarmName: '',
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, true, onClose);

  // Errors render at the top of the scrollable body; if the user has scrolled
  // down a long step (e.g. the roster) a new error would be hidden above the
  // fold and the action would look like a silent no-op. Pull it into view.
  useEffect(() => {
    if (error) bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [error]);

  const update = (patch: Partial<WizardState>) => setState((prev) => ({ ...prev, ...patch }));

  const stepProps: WizardStepProps = { state, update, projectPath };
  const isLast = state.step === STEPS.length - 1;

  const nextDisabled = useMemo(() => {
    switch (state.step) {
      case 0: return state.agents.length === 0;
      case 1: return state.mission.trim() === '';
      case 2: return state.directory.trim() === '';
      case 4: return state.swarmName.trim() === '';
      default: return false;
    }
  }, [state]);

  const goToStep = (target: number) => { setError(null); update({ step: target }); };

  const handleNext = () => {
    setError(null);
    if (state.step === 0) {
      if (state.agents.length === 0) { setError('Add at least one agent to the roster.'); return; }
      if (hasDependencyCycle(state.agents)) {
        setError('Dependency cycle detected — adjust the roster before continuing.');
        return;
      }
    }
    if (!isLast) update({ step: state.step + 1 });
  };

  const handleLaunch = async () => {
    if (!state.directory.trim()) { setError('Choose a working directory first.'); return; }
    // Preflight hard-block: a provider whose CLI is definitively not installed can only
    // produce instantly-failed agents. (Soft issues — no stored credentials — stay warnings.)
    const { providers } = useProviderStore.getState();
    const missingClis = Array.from(
      new Set(state.agents.map((a) => (a.provider || 'codex') as AgentProvider)),
    ).filter((p) => providers.find((x) => x.provider === p)?.installed === false);
    if (missingClis.length > 0) {
      setError(`CLI not installed for ${missingClis.map((p) => PROVIDER_LABELS[p]).join(', ')} — install it or change those agents' provider in the Roster step.`);
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      await useSwarmStore.getState().startSwarmFromWizard({
        projectPath: state.directory,
        swarmName: state.swarmName.trim() || 'Swarm',
        mission: state.mission,
        agents: state.agents,
        skills: state.skills,
        contextFiles: state.contextFiles,
        templateId: state.startedFromTemplateId,
      });
      onClose();
    } catch (e) {
      setError(`Failed to launch swarm: ${e}`);
      setLaunching(false);
    }
  };

  const renderStep = () => {
    switch (state.step) {
      case 0: return <RosterStep {...stepProps} />;
      case 1: return <MissionStep {...stepProps} />;
      case 2: return <DirectoryStep {...stepProps} />;
      case 3: return <ContextStep {...stepProps} />;
      case 4: return <NameStep {...stepProps} />;
      case 5: return <LaunchStep {...stepProps} />;
      default: return null;
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        className="modal-container wizard"
        style={containerStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="swarm-wizard-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div style={headerStyle}>
          <span id="swarm-wizard-title" className="swarm-strong">Create Swarm</span>
          <button onClick={onClose} style={closeBtnStyle} title="Close" aria-label="Close swarm wizard"><X size={16} /></button>
        </div>

        {/* Stepper */}
        <div style={stepperStyle}>
          {STEPS.map((s, i) => {
            const complete = i < state.step;
            const active = i === state.step;
            const Icon = s.icon;
            return (
              <React.Fragment key={s.key}>
                <button
                  onClick={() => (complete ? goToStep(i) : undefined)}
                  style={stepPillStyle(active, complete)}
                  disabled={!complete && !active}
                  aria-current={active ? 'step' : undefined}
                >
                  <span className="swarm-inline-flex">{complete ? <Check size={13} /> : <Icon size={13} />}</span>
                  <span className="swarm-uppercase">{s.label}</span>
                </button>
                {i < STEPS.length - 1 && <div style={connectorStyle(complete)} />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Body */}
        <div style={bodyStyle} ref={bodyRef}>
          {error && (
            <div style={errorBannerStyle}><AlertCircle size={14} /><span>{error}</span></div>
          )}
          {renderStep()}
        </div>

        {/* Footer */}
        <div style={footerStyle}>
          {state.step === 0 ? (
            <button onClick={onClose} style={ghostBtnStyle}>Cancel</button>
          ) : (
            <button onClick={() => goToStep(state.step - 1)} style={ghostBtnStyle}>
              <ChevronLeft size={14} /> Back
            </button>
          )}
          <span className="swarm-eyebrow">
            STEP {state.step + 1} OF {STEPS.length}
          </span>
          {isLast ? (
            <button onClick={handleLaunch} className="primary" style={primaryBtnStyle} disabled={launching}>
              <Rocket size={14} /> {launching ? 'Launching…' : 'Launch Swarm'}
            </button>
          ) : (
            <button onClick={handleNext} className="primary" style={primaryBtnStyle} disabled={nextDisabled}>
              Next <ChevronRight size={14} />
            </button>
          )}
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
  maxWidth: '880px',
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

const stepperStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  padding: '14px 20px',
  borderBottom: '1px solid var(--border)',
  overflowX: 'auto',
};

const stepPillStyle = (active: boolean, complete: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  padding: '6px 12px',
  borderRadius: 'var(--radius-full)',
  fontSize: '11px',
  fontWeight: 700,
  whiteSpace: 'nowrap',
  cursor: complete ? 'pointer' : 'default',
  border: `1px solid ${active || complete ? 'rgba(93, 95, 239, 0.65)' : 'var(--border)'}`,
  background: active ? 'var(--accent-light)' : 'transparent',
  color: active || complete ? 'var(--text-primary)' : 'var(--text-muted)',
});

const connectorStyle = (complete: boolean): React.CSSProperties => ({
  flex: 1,
  minWidth: '8px',
  height: '1px',
  background: complete ? 'rgba(93, 95, 239, 0.5)' : 'var(--border)',
});

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '24px',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
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
