import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const { projectState } = vi.hoisted(() => ({
  projectState: {
    currentProjectPath: 'C:\\work\\active',
    currentProjectName: 'active',
    currentWorkspaceId: null,
    recentProjects: [],
    workspaceHistory: [],
    openWorkspaces: [],
    stalePaths: ['C:\\work\\missing-one', 'C:\\work\\missing-two'],
    workspaceSummary: null,
    workspaceLoading: false,
    workspaceError: null,
    onboardingOpen: false,
    onboardingDismissed: true,
    workspaceConfig: null,
  },
}));

vi.mock('../../stores/projectStore', () => {
  const useProjectStore = Object.assign(
    (selector: (state: typeof projectState) => unknown) => selector(projectState),
    { getState: () => projectState },
  );
  return {
    ROOM_ORDER: ['dashboard', 'terminals', 'kanban', 'memory', 'swarm', 'review', 'editor', 'settings'],
    useProjectStore,
  };
});

import { ProjectDashboard } from './ProjectDashboard';

describe('ProjectDashboard', () => {
  it('does not put stale-workspace recovery controls on Home', () => {
    const html = renderToStaticMarkup(<ProjectDashboard />);

    expect(html).not.toContain('Workspace folder not found');
    expect(html).not.toContain('Relocate missing-one');
  });
});
