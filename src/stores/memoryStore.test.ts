import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route Tauri IPC to a controllable mock so store logic runs without a webview.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useMemoryStore, orderNodesByRank, type MemoryNode, type RankedMemoryHit } from './memoryStore';

const node = (id: string): MemoryNode => ({
  id,
  title: id,
  category: 'general',
  tags: [],
  aliases: [],
  filePath: `general/${id}.md`,
});

describe('memoryStore.loadNote', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useMemoryStore.setState({ activeNote: null, activeNoteContent: '', loading: false, error: null });
  });

  it('a slow stale response cannot overwrite a newer note (request currency)', async () => {
    let resolveOld!: (v: string) => void;
    const oldPromise = new Promise<string>((r) => (resolveOld = r));

    invokeMock.mockImplementation((cmd: string, args: { filePath: string }) => {
      if (cmd === 'read_memory_file') {
        return args.filePath.includes('old') ? oldPromise : Promise.resolve('new content');
      }
      if (cmd === 'get_unlinked_mentions') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    const store = useMemoryStore.getState();
    const first = store.loadNote('/proj', node('old'));
    const second = store.loadNote('/proj', node('new'));
    await second;

    // The older request resolves *after* the newer one committed.
    resolveOld('old content');
    await first;

    const state = useMemoryStore.getState();
    expect(state.activeNote?.id).toBe('new');
    expect(state.activeNoteContent).toBe('new content');
  });

  it('strips frontmatter and the leading H1 from loaded content', async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'read_memory_file') {
        return Promise.resolve('---\nid: x\n---\n\n# Title\n\nbody text');
      }
      if (cmd === 'get_unlinked_mentions') return Promise.resolve([]);
      return Promise.resolve(null);
    });

    await useMemoryStore.getState().loadNote('/proj', node('x'));
    expect(useMemoryStore.getState().activeNoteContent).toBe('body text');
  });
});

describe('memoryStore.setActiveNote', () => {
  it('clears the editor body for a blank new note', () => {
    useMemoryStore.setState({ activeNoteContent: 'previous note body' });
    useMemoryStore.getState().setActiveNote({ ...node(''), id: '', filePath: '' });
    expect(useMemoryStore.getState().activeNoteContent).toBe('');
  });
});

describe('orderNodesByRank', () => {
  const hits: RankedMemoryHit[] = [
    { id: 'exact', score: 4000, matchReason: 'title' },
    { id: 'body', score: 2003, matchReason: 'body' },
    { id: 'links', score: 1002, matchReason: 'backlinks' },
  ];

  it('orders ranked hits by score and pushes unranked nodes after, preserving their order', () => {
    const nodes = [node('unranked-a'), node('body'), node('unranked-b'), node('links'), node('exact')];
    const ordered = orderNodesByRank(nodes, hits);
    expect(ordered.map((n) => n.id)).toEqual(['exact', 'body', 'links', 'unranked-a', 'unranked-b']);
  });

  it('returns the original array untouched when there are no hits', () => {
    const nodes = [node('b'), node('a')];
    expect(orderNodesByRank(nodes, [])).toEqual(nodes);
  });
});
