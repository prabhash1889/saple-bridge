import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface LibraryPrompt {
  id: string;
  name: string;
  text: string;
}

// Seed defaults extracted verbatim from the surfaces that consume prompts: the Kanban task
// dialog role presets (ROLE_PROMPTS in TaskDialog.tsx) and the swarm wizard role defaults
// (ROLE_DEFAULT_PROMPT in swarm/wizard/constants.ts). Stable ids let deletions stay deleted.
export const DEFAULT_LIBRARY_PROMPTS: LibraryPrompt[] = [
  {
    id: 'prompt-autonomous-builder',
    name: 'Autonomous Builder',
    text: 'You are an autonomous development builder. Follow instructions carefully.',
  },
  {
    id: 'prompt-bug-fixer',
    name: 'Bug Fixer',
    text: 'You are an autonomous bug fixing agent. Locate the root cause of the described issue, resolve it safely, write regression unit tests, and check that all tests pass successfully.',
  },
  {
    id: 'prompt-feature-builder',
    name: 'Feature Builder',
    text: 'You are an autonomous feature builder. Implement the requested feature, write descriptive code comments, structure modules cleanly, write unit tests, and verify overall code correctness.',
  },
  {
    id: 'prompt-code-reviewer',
    name: 'Code Reviewer',
    text: 'You are an expert code quality and security reviewer. Analyze the specified files, check for vulnerabilities (OWASP top 10), logical errors, performance bottlenecks, and style inconsistencies.',
  },
  {
    id: 'prompt-code-architect',
    name: 'Code Architect (Refactor)',
    text: 'You are an expert code refactoring agent. Restructure the target modules for better readability, modularity, and performance. Do not alter functional behaviors. Ensure existing tests pass.',
  },
  {
    id: 'prompt-test-generator',
    name: 'Test Generator',
    text: 'You are an autonomous test generation agent. Review the codebase to identify missing tests, write comprehensive unit and integration tests, and run them to ensure coverage is added.',
  },
  {
    id: 'prompt-documentation-writer',
    name: 'Documentation Writer',
    text: 'You are an autonomous technical writer. Update the documentation, READMEs, API specs, and inline code comments to reflect the current codebase implementation and usage guides.',
  },
  {
    id: 'prompt-scout-investigator',
    name: 'Scout / Investigator',
    text: 'You are an autonomous scout. Investigate the codebase, search for relevant files, locate modules or APIs, and write a summary explaining your findings without making code changes.',
  },
  {
    id: 'prompt-swarm-coordinator',
    name: 'Swarm Coordinator',
    text: 'You are the Swarm Coordinator. Analyze the mission, break it into modular tasks, write them to .saple/swarm/tasks.json, and coordinate the other agents.',
  },
  {
    id: 'prompt-swarm-builder',
    name: 'Swarm Builder',
    text: 'You are a Builder. Read your assigned sub-task from .saple/swarm/tasks.json, implement the code, and write tests for it.',
  },
  {
    id: 'prompt-swarm-scout',
    name: 'Swarm Scout',
    text: 'You are a Scout. Investigate the codebase and relevant logs, gather context, and document your findings in your mailbox for the rest of the swarm.',
  },
  {
    id: 'prompt-swarm-reviewer',
    name: 'Swarm Reviewer',
    text: 'You are a Reviewer. Validate that the builders completed their tasks, verify the code compiles and tests pass, and signal approval or report blockers.',
  },
];

// Defaults minus the ones the user explicitly deleted, so seeds never resurrect on reload.
export function resolveSeededPrompts(deletedDefaultIds: string[]): LibraryPrompt[] {
  const deleted = new Set(deletedDefaultIds);
  return DEFAULT_LIBRARY_PROMPTS.filter((p) => !deleted.has(p.id));
}

export interface PromptDraft {
  name: string;
  text: string;
}

const createPromptId = (): string => {
  if (globalThis.crypto?.randomUUID) return `prompt_${globalThis.crypto.randomUUID()}`;
  return `prompt_${Date.now().toString(36)}_${Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(36)}`;
};

interface PromptLibraryState {
  prompts: LibraryPrompt[];
  deletedDefaultIds: string[];
  addPrompt: (draft: PromptDraft) => void;
  updatePrompt: (id: string, updates: Partial<PromptDraft>) => void;
  removePrompt: (id: string) => void;
}

// User-level reusable prompts, persisted to localStorage like theme/font/SSH-preset prefs.
// Prompts are not secrets; no project files or keychain are involved.
export const usePromptLibraryStore = create<PromptLibraryState>()(
  persist(
    (set) => ({
      prompts: resolveSeededPrompts([]),
      deletedDefaultIds: [],
      addPrompt: (draft) =>
        set((state) => ({
          prompts: [...state.prompts, { ...draft, id: createPromptId() }],
        })),
      updatePrompt: (id, updates) =>
        set((state) => ({
          prompts: state.prompts.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),
      removePrompt: (id) =>
        set((state) => ({
          prompts: state.prompts.filter((p) => p.id !== id),
          deletedDefaultIds: DEFAULT_LIBRARY_PROMPTS.some((d) => d.id === id)
            ? [...state.deletedDefaultIds, id]
            : state.deletedDefaultIds,
        })),
    }),
    {
      name: 'saple-bridge-prompt-library-store',
    },
  ),
);
