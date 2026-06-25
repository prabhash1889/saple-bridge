import type { AgentRole } from './agent';
import type { AgentProvider } from './provider';
import type { SwarmAgent } from '../stores/swarmStore';

export type SizePresetId = 'squad' | 'team' | 'platoon' | 'battalion';

export interface SizePreset {
  id: SizePresetId;
  label: string;
  count: number;
  // How many agents of each role the preset generates.
  roleMix: Partial<Record<AgentRole, number>>;
}

export type SkillCategory = 'Workflow' | 'Quality' | 'Ops' | 'Analysis';

export interface SwarmSkill {
  id: string;
  label: string;
  description: string;
  category: SkillCategory;
  // Instruction injected into every agent's prompt when the skill is active.
  promptText: string;
}

// A persisted reference to a context file written under .saple/swarm/context/.
export interface ContextFileRef {
  name: string;
  path: string;
}

// An in-wizard draft of an attached context file (content held until launch).
export interface ContextFileDraft {
  name: string;
  size: number;
  content: string;
}

// An editable agent inside the wizard roster. Runtime fields (status/taskId/
// terminalId) are seeded at launch, not edited here.
export type WizardAgent = Omit<SwarmAgent, 'status' | 'taskId' | 'terminalId'> & {
  autoApprove: boolean;
  expanded?: boolean;
};

// The fully-formed payload the wizard hands to the store to start a swarm. The
// store seeds agent run-state and writes the context drafts into .saple/ at launch.
export interface WizardLaunchInput {
  projectPath: string;
  swarmName: string;
  mission: string;
  agents: WizardAgent[];
  skills: string[];
  contextFiles: ContextFileDraft[];
  templateId?: string | null;
}

// Props every wizard step component receives from the SwarmWizard shell.
export interface WizardStepProps {
  state: WizardState;
  update: (patch: Partial<WizardState>) => void;
  projectPath: string | null;
}

// Shared wizard state, owned by the SwarmWizard shell.
export interface WizardState {
  step: number;
  // ROSTER
  sizePresetId: SizePresetId | null;
  globalProvider: AgentProvider;
  agents: WizardAgent[];
  startedFromTemplateId: string | null;
  // MISSION
  mission: string;
  skills: string[];
  // DIRECTORY
  directory: string;
  // CONTEXT
  contextFiles: ContextFileDraft[];
  // NAME
  swarmName: string;
}
