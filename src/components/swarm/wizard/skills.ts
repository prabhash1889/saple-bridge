import type { SwarmSkill } from '../../../types/wizard';

// Behavioral policies the user can toggle on the Mission step. When active, each
// skill's promptText is injected into every agent's mission brief at launch.
export const SWARM_SKILLS: SwarmSkill[] = [
  {
    id: 'tdd',
    label: 'Test-Driven',
    description: 'Write tests first, then implement to pass them.',
    category: 'Quality',
    promptText:
      'Follow test-driven development: write or update failing tests before implementing, then make them pass. Do not signal completion until the relevant tests pass.',
  },
  {
    id: 'code_review',
    label: 'Self Code Review',
    description: 'Review all changes before committing.',
    category: 'Quality',
    promptText:
      'Before signaling completion, perform a self-review of your diff for correctness, edge cases, and security issues; record findings in your mailbox.',
  },
  {
    id: 'security_audit',
    label: 'Security Audit',
    description: 'Check for vulnerabilities as you build.',
    category: 'Quality',
    promptText:
      'Scan your changes for injected secrets, unsafe input handling, and dependency risks. Report anything you find in your mailbox.',
  },
  {
    id: 'dry',
    label: 'DRY Principle',
    description: 'Eliminate code duplication aggressively.',
    category: 'Quality',
    promptText: 'Eliminate code duplication; prefer reusing existing helpers and utilities over re-implementing them.',
  },
  {
    id: 'incremental_commits',
    label: 'Incremental Commits',
    description: 'Commit small, atomic changes frequently.',
    category: 'Workflow',
    promptText: 'Make small, atomic commits using Conventional Commits format as you complete coherent units of work.',
  },
  {
    id: 'refactor_only',
    label: 'Refactor Only',
    description: 'Restructure without changing behavior.',
    category: 'Workflow',
    promptText: 'Restructure code without changing observable behavior. Do not add features or alter outputs.',
  },
  {
    id: 'documentation',
    label: 'Documentation',
    description: 'Document public APIs and changes.',
    category: 'Workflow',
    promptText: 'Update relevant docs, READMEs, and AGENTS.md when you change behavior or public interfaces.',
  },
  {
    id: 'handoff_protocol',
    label: 'Strict Handoff',
    description: 'Write structured handoffs before finishing.',
    category: 'Workflow',
    promptText:
      'Before finishing, write a structured JSON handoff to .saple/swarm/handoffs/<you>-to-<next>.json summarizing outputs and open questions.',
  },
  {
    id: 'keep_ci_green',
    label: 'Keep CI Green',
    description: 'Ensure all checks pass before merging.',
    category: 'Ops',
    promptText: 'Run the project linter, formatter, and test suite, and fix violations before signaling completion.',
  },
  {
    id: 'migration_safe',
    label: 'Migration Safe',
    description: 'Ensure DB changes are reversible.',
    category: 'Ops',
    promptText: 'Ensure any schema or data migration is reversible and safe to roll back. Provide a down-migration.',
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Optimize for speed and efficiency.',
    category: 'Analysis',
    promptText: 'Avoid performance regressions; prefer efficient algorithms and note any hot paths you touch.',
  },
  {
    id: 'root_cause',
    label: 'Root-Cause Analysis',
    description: 'Find the underlying cause, not symptoms.',
    category: 'Analysis',
    promptText: 'For any bug, identify and document the root cause (not just the symptom) before applying a fix.',
  },
];

export const getSkillById = (id: string): SwarmSkill | undefined => SWARM_SKILLS.find((s) => s.id === id);
