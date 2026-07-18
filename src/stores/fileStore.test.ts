import { describe, it, expect, vi, beforeEach } from 'vitest';

// Route Tauri IPC to a controllable mock so store logic runs without a webview.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { useFileStore, DEFAULT_PANEL_WIDTH } from './fileStore';
import { useFileLayoutStore } from './fileLayoutStore';
import { useConfirmStore } from './confirmStore';
import { useBrowserStore } from './browserStore';
import { useProjectStore } from './projectStore';

const reset = () => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'read_text_file') return Promise.resolve('file body');
    if (cmd === 'git_status') return Promise.resolve([]);
    return Promise.resolve(null);
  });
  useFileStore.getState().reset();
  useConfirmStore.setState({ isOpen: false, onConfirm: null, onCancel: null });
  useBrowserStore.setState({ workspaces: {}, live: {} });
  useProjectStore.setState({ currentWorkspaceId: null });
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

describe('fileStore layout persistence (P12)', () => {
  beforeEach(reset);

  it('prunes deleted/renamed paths from expanded folders and tabs on load', async () => {
    // Seed a workspace layout mixing paths that still exist with ones removed while away.
    useFileStore.setState({
      layoutPath: '/p',
      expanded: new Set(['live-dir', 'stale-dir']),
      openFiles: ['live.ts', 'stale.ts'],
      activeFile: 'stale.ts',
    });
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_project_files') {
        return Promise.resolve([
          { name: 'live-dir', path: 'live-dir', isDir: true, sizeBytes: null },
          { name: 'live.ts', path: 'live.ts', isDir: false, sizeBytes: 1 },
        ]);
      }
      if (cmd === 'read_text_file') return Promise.resolve('body');
      return Promise.resolve(null);
    });

    await useFileStore.getState().loadFiles('/p');

    const st = useFileStore.getState();
    expect([...st.expanded]).toEqual(['live-dir']);
    expect(st.openFiles).toEqual(['live.ts']);
    // The active tab was pruned, so it falls back to the surviving tab rather than resurrecting.
    expect(st.activeFile).toBe('live.ts');
  });

  it('restores a persisted layout for the workspace path', () => {
    useFileLayoutStore.getState().setLayout('/w', {
      expanded: ['src'],
      openFiles: ['src/a.ts', 'README.md'],
      activeFile: 'src/a.ts',
    });

    useFileStore.getState().restoreLayout('/w');

    const st = useFileStore.getState();
    expect([...st.expanded]).toEqual(['src']);
    expect(st.openFiles).toEqual(['src/a.ts', 'README.md']);
    expect(st.activeFile).toBe('src/a.ts');
    expect(st.layoutPath).toBe('/w');
  });

  it('restoreLayout(null) clears state so a no-project view shows nothing', () => {
    useFileStore.setState({ layoutPath: '/p', openFiles: ['a.ts'], activeFile: 'a.ts' });

    useFileStore.getState().restoreLayout(null);

    const st = useFileStore.getState();
    expect(st.openFiles).toEqual([]);
    expect(st.activeFile).toBeNull();
    expect(st.layoutPath).toBeNull();
  });

  it('persists and restores the files-panel open state and width', () => {
    useFileLayoutStore.getState().setLayout('/w', {
      expanded: [],
      openFiles: [],
      activeFile: null,
      panelOpen: true,
      panelWidth: 640,
    });

    useFileStore.getState().restoreLayout('/w');

    const st = useFileStore.getState();
    expect(st.panelOpen).toBe(true);
    expect(st.panelWidth).toBe(640);
  });

  it('defaults panel state when a restored layout predates the feature', () => {
    useFileLayoutStore.getState().setLayout('/w', {
      expanded: [],
      openFiles: [],
      activeFile: null,
    });

    useFileStore.getState().restoreLayout('/w');

    const st = useFileStore.getState();
    expect(st.panelOpen).toBe(false);
    expect(st.panelWidth).toBe(DEFAULT_PANEL_WIDTH);
  });
});

describe('fileStore / browser panel mutual exclusion', () => {
  beforeEach(reset);

  it('togglePanel opens then closes the files panel', () => {
    useProjectStore.setState({ currentWorkspaceId: 'w1' });

    useFileStore.getState().togglePanel();
    expect(useFileStore.getState().panelOpen).toBe(true);

    useFileStore.getState().togglePanel();
    expect(useFileStore.getState().panelOpen).toBe(false);
  });

  it('opening the files panel closes an open browser panel', () => {
    useProjectStore.setState({ currentWorkspaceId: 'w1' });
    useBrowserStore.getState().openPanel('w1');
    expect(useBrowserStore.getState().workspaces['w1'].isOpen).toBe(true);

    useFileStore.getState().openPanel();

    expect(useFileStore.getState().panelOpen).toBe(true);
    expect(useBrowserStore.getState().workspaces['w1'].isOpen).toBe(false);
  });

  it('opening the browser panel closes an open files panel', () => {
    useProjectStore.setState({ currentWorkspaceId: 'w1' });
    useFileStore.getState().openPanel();
    expect(useFileStore.getState().panelOpen).toBe(true);

    // Browser opening fires the subscription that closes the files panel.
    useBrowserStore.getState().openPanel('w1');

    expect(useBrowserStore.getState().workspaces['w1'].isOpen).toBe(true);
    expect(useFileStore.getState().panelOpen).toBe(false);
  });
});
