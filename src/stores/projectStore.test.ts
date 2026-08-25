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

describe('projectStore.removeRecentProject', () => {
  it('drops the path from recents and history but keeps open instances', () => {
    useProjectStore.setState({
      recentProjects: ['/p/a', '/p/b'],
      workspaceHistory: [
        { path: '/p/a', name: 'a', openedAt: 1 },
        { path: '/p/b', name: 'b', openedAt: 2 },
      ],
      openWorkspaces: [ws('a')],
      currentProjectPath: '/p/a',
    });

    useProjectStore.getState().removeRecentProject('/p/b');

    const state = useProjectStore.getState();
    expect(state.recentProjects).toEqual(['/p/a']);
    expect(state.workspaceHistory.map((e) => e.path)).toEqual(['/p/a']);
    // Open instances and the active workspace are untouched by a recents removal.
    expect(state.openWorkspaces.map((w) => w.id)).toEqual(['a']);
    expect(state.currentProjectPath).toBe('/p/a');
  });

  it('removing the last occurrence leaves the lists empty without touching workspaces', () => {
    useProjectStore.setState({
      recentProjects: ['/p/solo'],
      workspaceHistory: [{ path: '/p/solo', name: 'solo', openedAt: 1 }],
      openWorkspaces: [],
      currentProjectPath: null,
    });

    useProjectStore.getState().removeRecentProject('/p/solo');

    const state = useProjectStore.getState();
    expect(state.recentProjects).toEqual([]);
    expect(state.workspaceHistory).toEqual([]);
  });
});
