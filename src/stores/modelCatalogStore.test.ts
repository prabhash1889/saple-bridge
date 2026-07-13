import { describe, it, expect, beforeEach } from 'vitest';
import { assembleModelCatalog, useModelCatalogStore } from './modelCatalogStore';

describe('assembleModelCatalog', () => {
  it('orders aliases, then recents, then API ids, deduped', () => {
    const out = assembleModelCatalog('claude', ['my-tuned', 'opus'], ['claude-x', 'my-tuned']);
    // claude aliases first (default/sonnet/opus/haiku), 'opus' not repeated by recents,
    // 'my-tuned' appears once, API 'claude-x' last.
    expect(out).toEqual(['default', 'sonnet', 'opus', 'haiku', 'my-tuned', 'claude-x']);
  });

  it('falls back to a bare default for a provider with no alias list', () => {
    expect(assembleModelCatalog('opencode')).toEqual(['default']);
  });

  it('drops empty entries', () => {
    expect(assembleModelCatalog('codex', ['', 'a'], [''])).toEqual(['default', 'a']);
  });
});

describe('recordUsed', () => {
  beforeEach(() => useModelCatalogStore.setState({ recents: {}, apiModels: {}, fetched: {} }));

  it('records concrete models newest-first without duplicates, but skips aliases', () => {
    const { recordUsed } = useModelCatalogStore.getState();
    recordUsed('claude', 'opus'); // alias — skipped
    recordUsed('claude', 'default'); // skipped
    recordUsed('claude', 'claude-x');
    recordUsed('claude', 'claude-y');
    recordUsed('claude', 'claude-x'); // moves to front, no dup
    expect(useModelCatalogStore.getState().recents.claude).toEqual(['claude-x', 'claude-y']);
  });

  it('caps recents at 8', () => {
    const { recordUsed } = useModelCatalogStore.getState();
    for (let i = 0; i < 12; i++) recordUsed('codex', `m-${i}`);
    expect(useModelCatalogStore.getState().recents.codex).toHaveLength(8);
    expect(useModelCatalogStore.getState().recents.codex?.[0]).toBe('m-11');
  });
});
