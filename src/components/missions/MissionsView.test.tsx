import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const { projectState, missionState, notificationState } = vi.hoisted(() => ({
  projectState: {
    currentProjectPath: 'C:/proj',
    openWorkspace: vi.fn(),
    setActiveView: vi.fn(),
  },
  missionState: {
    missions: [
      {
        id: 'msn_a',
        title: 'Add OAuth login',
        status: 'draft',
        taskTotal: 1,
        taskCompleted: 0,
        updatedAt: '2026-08-26T00:00:00Z',
      },
    ],
    loading: false,
    error: null,
    activeId: 'msn_a',
    activeState: {
      id: 'msn_a',
      revision: 1,
      status: 'draft',
      spec: {
        title: 'Add OAuth login',
        objective: 'Ship login',
        acceptance: [],
        maxParallel: 4,
        maxRounds: 12,
        budgetUsdCap: 15,
        worktreeMode: 'shared',
      },
      tasks: [
        {
          id: 'task_a',
          title: 'Implement login',
          kind: 'implement',
          spec: 'Build it',
          deps: [],
          fanout: 1,
          status: 'ready',
        },
      ],
      events: [],
      idempotency: {},
      createdAt: '2026-08-26T00:00:00Z',
      updatedAt: '2026-08-26T00:00:00Z',
    },
    activeDoc: '---\ntitle: Add OAuth login\n---\n',
    activeWarnings: [],
    loadMissions: vi.fn(),
    openMission: vi.fn(),
  },
  notificationState: { success: vi.fn() },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../../stores/projectStore', () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) => selector(projectState),
}));
vi.mock('../../stores/missionStore', () => ({
  useMissionStore: Object.assign(
    (selector: (state: typeof missionState) => unknown) => selector(missionState),
    { getState: () => missionState },
  ),
}));
vi.mock('../../stores/notificationStore', () => ({
  useNotificationStore: { getState: () => notificationState },
}));

import { MissionsView } from './MissionsView';

describe('MissionsView', () => {
  it('renders the mission detail, markdown editor, and task table', () => {
    const html = renderToStaticMarkup(<MissionsView />);

    expect(html).toContain('Add OAuth login');
    expect(html).toContain('mission.md');
    expect(html).toContain('Mission markdown editor');
    expect(html).toContain('Tasks (1)');
  });
});
