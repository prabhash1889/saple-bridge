import { describe, it, expect, beforeEach, vi } from 'vitest';

// projectStore pulls in Tauri IPC at import time via its actions; none of the reducers under
// test (moveWorkspace / renameWorkspace) call it, so a no-op mock is enough to load the module.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { useProjectStore, type WorkspaceInstance } from './projectStore';

const ws = (id: string, name = id): WorkspaceInstance => ({ id, path: `/p/${id}`, name });

describe('projectStore workspace ordering + rename', () => {
  beforeEach(() => {
    useProjectStore.setState({
      openWorkspaces: [ws('a'), ws('b'), ws('c')],
      currentWorkspaceId: null,
      currentProjectName: null,
    });
  });

  const ids = () => useProjectStore.getState().openWorkspaces.map((w) => w.id);

  it('moves a workspace up and down by swapping neighbours', () => {
    useProjectStore.getState().moveWorkspace('c', 'up');
    expect(ids()).toEqual(['a', 'c', 'b']);
    useProjectStore.getState().moveWorkspace('c', 'down');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('is a no-op at the list edges', () => {
    useProjectStore.getState().moveWorkspace('a', 'up');
    useProjectStore.getState().moveWorkspace('c', 'down');
    expect(ids()).toEqual(['a', 'b', 'c']);
  });

  it('renames an instance and ignores blank names', () => {
    useProjectStore.getState().renameWorkspace('b', '  My repo  ');
    expect(useProjectStore.getState().openWorkspaces[1].name).toBe('My repo');
    useProjectStore.getState().renameWorkspace('b', '   ');
    expect(useProjectStore.getState().openWorkspaces[1].name).toBe('My repo');
  });

  it('syncs currentProjectName when renaming the active workspace', () => {
    useProjectStore.setState({ currentWorkspaceId: 'a', currentProjectName: 'a' });
    useProjectStore.getState().renameWorkspace('a', 'Active');
    expect(useProjectStore.getState().currentProjectName).toBe('Active');
    useProjectStore.getState().renameWorkspace('b', 'Other');
    expect(useProjectStore.getState().currentProjectName).toBe('Active');
  });
});
