import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route Tauri IPC to a controllable mock so store logic runs without a webview.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useMemoryStore, type MemoryNode } from './memoryStore';

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

    invokeMock.mockImplementation((cmd: string, args: any) => {
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
