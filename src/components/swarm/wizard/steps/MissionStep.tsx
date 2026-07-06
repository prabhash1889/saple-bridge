import React from 'react';
import { MessageSquare, Sparkles, Check } from 'lucide-react';
import type { WizardStepProps, SkillCategory } from '../../../../types/wizard';
import { SWARM_SKILLS } from '../skills';
import {
  heroWrapStyle, heroIconWrapStyle, heroTitleStyle, heroSubtitleStyle, sectionLabelStyle, textareaStyle,
} from '../wizardStyles';

const CATEGORY_ORDER: SkillCategory[] = ['Workflow', 'Quality', 'Ops', 'Analysis'];
const CATEGORY_COLOR: Record<SkillCategory, string> = {
  Workflow: 'var(--accent)',
  Quality: 'var(--color-success)',
  Ops: 'var(--color-warning)',
  Analysis: 'var(--accent-swarm)',
};

export const MissionStep: React.FC<WizardStepProps> = ({ state, update }) => {
  const { mission, skills } = state;

  const toggleSkill = (id: string) =>
    update({ skills: skills.includes(id) ? skills.filter((s) => s !== id) : [...skills, id] });

  return (
    <div>
      <div style={heroWrapStyle}>
        <div style={heroIconWrapStyle}><MessageSquare size={24} /></div>
        <h2 style={heroTitleStyle}>Swarm <span className="extracted-style-202">mission</span></h2>
        <p style={heroSubtitleStyle}>Describe what you want this swarm to build or fix. This is shared with all agents as their mission brief.</p>
      </div>

      <div className="extracted-style-203">
        <textarea
          value={mission}
          onChange={(e) => update({ mission: e.target.value })}
          placeholder="What should this swarm accomplish? Agents will read this as their mission brief."
          style={{ ...textareaStyle, minHeight: '140px' }}
        />
        <span className="extracted-style-204">
          {mission.length} chars
        </span>
      </div>
      <div className="extracted-style-205">
        <Sparkles size={12} className="extracted-style-206" />
        Shared with all agents so they can coordinate and stay aligned.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', ...sectionLabelStyle, marginBottom: '12px' }}>
        <Sparkles size={12} /> Swarm Skills
      </div>

      {CATEGORY_ORDER.map((cat) => {
        const items = SWARM_SKILLS.filter((s) => s.category === cat);
        if (items.length === 0) return null;
        return (
          <div key={cat} className="extracted-style-207">
            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: CATEGORY_COLOR[cat], marginBottom: '8px' }}>{cat}</div>
            <div className="extracted-style-208">
              {items.map((skill) => {
                const selected = skills.includes(skill.id);
                return (
                  <button
                    key={skill.id}
                    onClick={() => toggleSkill(skill.id)}
                    style={{
                      textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: '8px', padding: '10px 12px',
                      borderRadius: 'var(--radius-md)', cursor: 'pointer',
                      border: `1px solid ${selected ? CATEGORY_COLOR[cat] : 'var(--border)'}`,
                      background: selected ? 'var(--accent-light)' : 'var(--bg-surface-light)',
                    }}
                  >
                    <span
                      style={{
                        marginTop: '2px', width: '16px', height: '16px', borderRadius: '4px', flexShrink: 0,
                        display: 'grid', placeItems: 'center',
                        border: `1px solid ${selected ? CATEGORY_COLOR[cat] : 'var(--border-hover)'}`,
                        background: selected ? CATEGORY_COLOR[cat] : 'transparent',
                        color: '#0B0C0E',
                      }}
                    >
                      {selected && <Check size={11} strokeWidth={3} />}
                    </span>
                    <span className="extracted-style-209">
                      <span className="extracted-style-210">{skill.label}</span>
                      <span className="extracted-style-211">{skill.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
};
