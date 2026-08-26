import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_LIBRARY_PROMPTS,
  resolveSeededPrompts,
  usePromptLibraryStore,
} from './promptLibraryStore';

const store = () => usePromptLibraryStore.getState();

describe('resolveSeededPrompts', () => {
  it('returns every default prompt with no deletions', () => {
    expect(resolveSeededPrompts([])).toEqual(DEFAULT_LIBRARY_PROMPTS);
  });

  it('drops defaults the user deleted', () => {
    const seeded = resolveSeededPrompts(['prompt-bug-fixer', 'prompt-swarm-coordinator']);
    expect(seeded.some((p) => p.id === 'prompt-bug-fixer')).toBe(false);
    expect(seeded.some((p) => p.id === 'prompt-swarm-coordinator')).toBe(false);
    expect(seeded).toHaveLength(DEFAULT_LIBRARY_PROMPTS.length - 2);
  });
});

describe('promptLibraryStore', () => {
  beforeEach(() => {
    usePromptLibraryStore.setState({
      prompts: resolveSeededPrompts([]),
      deletedDefaultIds: [],
    });
  });

  it('seeds the library with the default prompts on first use', () => {
    expect(store().prompts.length).toBe(DEFAULT_LIBRARY_PROMPTS.length);
    expect(store().prompts.map((p) => p.name)).toContain('Bug Fixer');
    expect(store().prompts.map((p) => p.name)).toContain('Swarm Coordinator');
  });

  it('adds a custom prompt with generated id', () => {
    store().addPrompt({ name: 'My Prompt', text: 'Do the thing.' });
    const added = store().prompts.find((p) => p.name === 'My Prompt');
    expect(added?.text).toBe('Do the thing.');
    expect(added?.id).toMatch(/^prompt_/);
  });

  it('renames and edits prompt text without changing identity', () => {
    store().addPrompt({ name: 'Draft', text: 'Old text' });
    const draft = store().prompts.find((p) => p.name === 'Draft')!;
    store().updatePrompt(draft.id, { name: 'Final', text: 'New text' });
    const updated = store().prompts.find((p) => p.id === draft.id);
    expect(updated).toMatchObject({ id: draft.id, name: 'Final', text: 'New text' });
    expect(store().prompts.filter((p) => p.name === 'Draft')).toHaveLength(0);
  });

  it('removes a default prompt, records the deletion, and never reseeds it', () => {
    const bugFixer = store().prompts.find((p) => p.id === 'prompt-bug-fixer')!;
    store().removePrompt(bugFixer.id);

    expect(store().prompts.some((p) => p.id === 'prompt-bug-fixer')).toBe(false);
    expect(store().deletedDefaultIds).toContain('prompt-bug-fixer');

    // Simulates a reload: seeding again from the recorded deletions keeps it gone.
    const reseeded = resolveSeededPrompts(store().deletedDefaultIds);
    expect(reseeded.some((p) => p.id === 'prompt-bug-fixer')).toBe(false);
  });

  it('removes custom prompts without touching default deletion tracking', () => {
    store().addPrompt({ name: 'Temp', text: 'x' });
    const temp = store().prompts.find((p) => p.name === 'Temp')!;
    store().removePrompt(temp.id);
    expect(store().prompts.some((p) => p.id === temp.id)).toBe(false);
    expect(store().deletedDefaultIds).toHaveLength(0);
  });
});
