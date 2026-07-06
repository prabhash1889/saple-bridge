import React, { useEffect } from 'react';
import { Tag } from 'lucide-react';
import type { WizardStepProps } from '../../../../types/wizard';
import { heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionLabelStyle, inputStyle } from '../wizardStyles';

const deriveName = (mission: string): string => {
  const words = mission.trim().split(/\s+/).filter(Boolean).slice(0, 5).join(' ');
  return words ? `${words} Swarm`.slice(0, 60) : 'New Swarm';
};

export const NameStep: React.FC<WizardStepProps> = ({ state, update }) => {
  const { swarmName, mission } = state;

  // Suggest a default name from the mission the first time this step is shown.
  useEffect(() => {
    if (!swarmName.trim()) update({ swarmName: deriveName(mission) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><Tag size={24} /></div>
        <h2 style={heroTitleStyle}>Name your <span className="fg-accent">swarm</span></h2>
        <p style={heroSubtitleStyle}>Give this swarm a recognizable name so you can find it later.</p>
      </div>

      <div className="swarm-narrow">
        <div style={sectionLabelStyle}>Swarm Name</div>
        <input
          value={swarmName}
          onChange={(e) => update({ swarmName: e.target.value })}
          placeholder="e.g. Auth Feature Swarm"
          style={inputStyle}
          autoFocus
        />
      </div>
    </div>
  );
};
