import type { AgentRole } from '../../../types/agent';
import type { AgentProvider } from '../../../types/provider';
import type { SizePreset, WizardAgent } from '../../../types/wizard';
import { PROVIDER_DEFAULT_MODEL } from './providerMeta';

export const ROLE_LABELS: Record<AgentRole, string> = {
  coordinator: 'Coordinator',
  builder: 'Builder',
  scout: 'Scout',
  reviewer: 'Reviewer',
};

// Mirrors the role color map in SwarmAgentCard.tsx / SwarmGraph.tsx.
export const ROLE_COLORS: Record<AgentRole, string> = {
  coordinator: 'var(--accent)',
  builder: 'var(--color-success)',
  reviewer: 'var(--color-info)',
  scout: 'var(--color-warning)',
};

export const ROLE_ORDER: AgentRole[] = ['coordinator', 'builder', 'scout', 'reviewer'];

const ROLE_DEFAULT_PROMPT: Record<AgentRole, string> = {
  coordinator:
    'You are the Swarm Coordinator. Analyze the mission, break it into modular tasks, write them to .saple/swarm/tasks.json, and coordinate the other agents.',
  builder:
    'You are a Builder. Read your assigned sub-task from .saple/swarm/tasks.json, implement the code, and write tests for it.',
  scout:
    'You are a Scout. Investigate the codebase and relevant logs, gather context, and document your findings in your mailbox for the rest of the swarm.',
  reviewer:
    'You are a Reviewer. Validate that the builders completed their tasks, verify the code compiles and tests pass, and signal approval or report blockers.',
};

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'squad', label: 'Squad', count: 5, roleMix: { coordinator: 1, builder: 2, scout: 1, reviewer: 1 } },
  { id: 'team', label: 'Team', count: 10, roleMix: { coordinator: 1, builder: 5, scout: 2, reviewer: 2 } },
  { id: 'platoon', label: 'Platoon', count: 15, roleMix: { coordinator: 1, builder: 8, scout: 3, reviewer: 3 } },
  { id: 'battalion', label: 'Battalion', count: 20, roleMix: { coordinator: 2, builder: 11, scout: 4, reviewer: 3 } },
];

// Build a layered, acyclic roster from a size preset:
//   coordinators (stage 0) -> builders + scouts (depend on first coordinator)
//   -> reviewers (depend on all builders).
export function generateRoster(preset: SizePreset, provider: AgentProvider): WizardAgent[] {
  const model = PROVIDER_DEFAULT_MODEL[provider] || 'default';
  const agents: WizardAgent[] = [];
  const idsByRole: Partial<Record<AgentRole, string[]>> = {};

  for (const role of ROLE_ORDER) {
    const count = preset.roleMix[role] || 0;
    idsByRole[role] = [];
    for (let i = 0; i < count; i++) {
      const idx = i + 1;
      const id = `${role}_${idx}`;
      idsByRole[role]!.push(id);
      agents.push({
        id,
        name: `${ROLE_LABELS[role]} ${idx}`,
        role,
        provider,
        model,
        systemPrompt: ROLE_DEFAULT_PROMPT[role],
        dependencies: [],
        autoApprove: false,
      });
    }
  }

  const firstCoordinator = idsByRole.coordinator?.[0];
  const builderIds = idsByRole.builder ?? [];

  for (const agent of agents) {
    if (agent.role === 'builder' || agent.role === 'scout') {
      if (firstCoordinator) agent.dependencies = [firstCoordinator];
    } else if (agent.role === 'reviewer') {
      agent.dependencies = builderIds.length > 0 ? [...builderIds] : firstCoordinator ? [firstCoordinator] : [];
    }
  }

  return agents;
}

// Detect a cycle in the agent dependency graph. This mirrors the Rust
// `validate_dependency_graph` command but runs client-side, so the wizard's
// "Next" gate never depends on an IPC round-trip that can fail (a rejected
// invoke would otherwise silently block navigation). Pure DFS with a
// three-color marking: 0 = unvisited, 1 = on the current stack, 2 = done.
export function hasDependencyCycle(agents: WizardAgent[]): boolean {
  const deps = new Map<string, string[]>();
  for (const a of agents) deps.set(a.id, a.dependencies);

  const mark = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const state = mark.get(id) ?? 0;
    if (state === 1) return true; // back-edge → cycle
    if (state === 2) return false;
    mark.set(id, 1);
    for (const dep of deps.get(id) ?? []) {
      if (deps.has(dep) && visit(dep)) return true;
    }
    mark.set(id, 2);
    return false;
  };

  return agents.some((a) => visit(a.id));
}

export const composeComposition = (agents: WizardAgent[]): { role: AgentRole; count: number }[] =>
  ROLE_ORDER.map((role) => ({ role, count: agents.filter((a) => a.role === role).length })).filter((c) => c.count > 0);
