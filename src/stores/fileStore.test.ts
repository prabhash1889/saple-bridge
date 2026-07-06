import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route Tauri IPC to a controllable mock so store logic runs without a webview.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useFileStore } from './fileStore';
import { useConfirmStore } from './confirmStore';

const reset = () => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'read_text_file') return Promise.resolve('file body');
    if (cmd === 'git_status') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useFileStore.getState().reset();
  useConfirmStore.setState({ isOpen: false, onConfirm: null, onCancel: null });
};

describe('fileStore tab logic', () => {
  beforeEach(reset);

  it('opens files as most-recent-first tabs, de-duplicating', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'a.ts');
    await Promise.resolve();
    s.openFile('/p', 'b.ts');
    await Promise.resolve();
    // Re-opening an existing file moves it to the front, no duplicate.
    s.openFile('/p', 'a.ts');
    await Promise.resolve();

    expect(useFileStore.getState().openFiles).toEqual(['a.ts', 'b.ts']);
    expect(useFileStore.getState().activeFile).toBe('a.ts');
  });

  it('closing the active tab activates the previous tab', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'a.ts');
    await Promise.resolve();
    s.openFile('/p', 'b.ts');
    await Promise.resolve();
    // openFiles is [b, a]; active is b.
    useFileStore.getState().closeTab('/p', 'b.ts');
    await Promise.resolve();

    const st = useFileStore.getState();
    expect(st.openFiles).toEqual(['a.ts']);
    expect(st.activeFile).toBe('a.ts');
  });

  it('closing the last tab clears the active file', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'only.ts');
    await Promise.resolve();
    useFileStore.getState().closeTab('/p', 'only.ts');
    await Promise.resolve();

    const st = useFileStore.getState();
    expect(st.openFiles).toEqual([]);
    expect(st.activeFile).toBeNull();
  });

  it('opening a file while dirty prompts to confirm instead of switching immediately', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'a.ts');
    await Promise.resolve();
    useFileStore.getState().setDirty(true);

    useFileStore.getState().openFile('/p', 'b.ts');
    // Nothing switched yet — a confirm dialog is pending.
    expect(useFileStore.getState().activeFile).toBe('a.ts');
    expect(useConfirmStore.getState().isOpen).toBe(true);

    // Approving the confirm discards edits and switches.
    useConfirmStore.getState().onConfirm?.();
    await Promise.resolve();
    await Promise.resolve();
    const st = useFileStore.getState();
    expect(st.activeFile).toBe('b.ts');
    expect(st.dirty).toBe(false);
  });

  it('renaming a path follows it in open tabs and the active file', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'old.ts');
    await Promise.resolve();
    await useFileStore.getState().renamePath('/p', 'old.ts', 'new.ts');

    const st = useFileStore.getState();
    expect(st.openFiles).toContain('new.ts');
    expect(st.openFiles).not.toContain('old.ts');
    expect(st.activeFile).toBe('new.ts');
  });

  it('deleting a folder closes tabs for its descendants', async () => {
    const s = useFileStore.getState();
    s.openFile('/p', 'dir/child.ts');
    await Promise.resolve();
    await useFileStore.getState().deletePath('/p', 'dir');

    const st = useFileStore.getState();
    expect(st.openFiles).toEqual([]);
    expect(st.activeFile).toBeNull();
  });
});
