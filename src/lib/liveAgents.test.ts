import { describe, it, expect, beforeEach, vi } from 'vitest';

// Both stores touch Tauri IPC at import time; the helpers under test only read plain
// state, so a no-op invoke mock is enough.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { useSwarmStore } from '../stores/swarmStore';
import { useTerminalStore } from '../stores/terminalStore';
import { getLiveAgents, describeLiveAgents } from './liveAgents';

const resetStores = () => {
  useSwarmStore.setState({ activeAgents: [] });
  useTerminalStore.setState({
    panes: [],
    sessions: {},
  });
};

describe('getLiveAgents', () => {
  beforeEach(resetStores);

  it('counts running and waiting swarm agents', () => {
    useSwarmStore.setState({
      activeAgents: [
        { id: 'a1', name: 'Builder', status: 'running' },
        { id: 'a2', name: 'Scout', status: 'waiting' },
        // Done/review agents are not interrupted by quitting.
        { id: 'a3', name: 'Reviewer', status: 'review' },
        { id: 'a4', name: 'Old', status: 'done' },
      ],
    } as never);

    const live = getLiveAgents();
    expect(live.swarm).toEqual(['Builder', 'Scout']);
    expect(live.terminals).toEqual([]);
  });

  it('only counts terminal panes linked to an agent session', () => {
    useTerminalStore.setState({
      panes: ['p1', 'p2'],
      sessions: {
        p1: {
          id: 'p1',
          name: 'CODEx Agent: fix bug',
          agentSessionId: 's1',
          cwd: '/p',
          workspacePath: '/p',
          workspaceId: 'w1',
          groupColor: '#000',
          commandBlocks: [],
          lastCommandInput: '',
        },
        p2: {
          id: 'p2',
          name: 'Shell 2',
          cwd: '/p',
          workspacePath: '/p',
          workspaceId: 'w1',
          groupColor: '#000',
          commandBlocks: [],
          lastCommandInput: '',
        },
      },
    } as never);

    expect(getLiveAgents().terminals).toEqual(['CODEx Agent: fix bug']);
  });

  it('describes zero live agents as an empty summary', () => {
    expect(describeLiveAgents(getLiveAgents())).toBe('');
  });

  it('formats a combined human summary', () => {
    useSwarmStore.setState({
      activeAgents: [
        { id: 'a1', name: 'A', status: 'running' },
        { id: 'a2', name: 'B', status: 'running' },
      ],
    } as never);
    expect(describeLiveAgents(getLiveAgents())).toBe('2 swarm agents');
  });
});
