import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TERMINAL_OUTPUT_BUFFER_CHARS } from '../lib/terminalLimits';

// terminalStore reaches into Tauri IPC and several sibling stores. Mock all of them so the pure
// state logic — workspace bucketing, focus resolution, output buffering/trimming, pane limits —
// runs without a webview or a real PTY.
const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

const projectRef = vi.hoisted(() => ({
  currentProjectPath: '/proj' as string | null,
  currentWorkspaceId: 'ws-1' as string | null,
  workspaceConfig: { maxParallelAgents: 16 } as { maxParallelAgents: number } | null,
}));
vi.mock('./projectStore', () => ({
  useProjectStore: { getState: () => projectRef },
}));

const layoutMock = vi.hoisted(() => ({
  setLayout: vi.fn(),
  clearLayout: vi.fn(),
  savedLayouts: {} as Record<string, unknown>,
}));
vi.mock('./terminalLayoutStore', () => ({
  useTerminalLayoutStore: { getState: () => layoutMock },
}));

import { useTerminalStore, subscribeRawTerminalEvents, getPaneSignalTail, type RawTerminalEvent } from './terminalStore';
import { useConfirmStore } from './confirmStore';

const store = () => useTerminalStore.getState();

beforeEach(async () => {
  await store().stopPtyOutputListener();
  invokeMock.mockReset().mockResolvedValue(undefined);
  listenMock.mockReset().mockResolvedValue(vi.fn());
  layoutMock.setLayout.mockReset();
  layoutMock.clearLayout.mockReset();
  projectRef.currentProjectPath = '/proj';
  projectRef.currentWorkspaceId = 'ws-1';
  projectRef.workspaceConfig = { maxParallelAgents: 16 };
  await store().clearAll();
});

describe('addPane', () => {
  it('waits for the shared PTY listeners before spawning', async () => {
    let finishOutputListener: ((unlisten: () => void) => void) | undefined;
    listenMock
      .mockImplementationOnce(() => new Promise<() => void>((resolve) => {
        finishOutputListener = resolve;
      }))
      .mockResolvedValueOnce(vi.fn());

    const initializePromise = store().initialize();
    const addPromise = store().addPane('/proj');

    expect(invokeMock).not.toHaveBeenCalledWith('spawn_pty', expect.anything());
    finishOutputListener?.(vi.fn());
    await Promise.all([initializePromise, addPromise]);

    expect(listenMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenCalledWith('spawn_pty', expect.objectContaining({ cwd: '/proj' }));
  });

  it('buckets the pane under the active workspace, focuses it, and spawns a PTY', async () => {
    const id = await store().addPane('/proj');

    expect(store().panes).toEqual([id]);
    expect(store().workspacePanes['ws-1']).toEqual([id]);
    expect(store().focusedPaneId).toBe(id);
    expect(store().sessions[id]?.cwd).toBe('/proj');
    expect(invokeMock).toHaveBeenCalledWith('spawn_pty', expect.objectContaining({ id, cwd: '/proj' }));
  });

  it('keeps two workspaces independent', async () => {
    const a = await store().addPane('/proj');
    projectRef.currentWorkspaceId = 'ws-2';
    const b = await store().addPane('/proj');

    expect(store().workspacePanes['ws-1']).toEqual([a]);
    expect(store().workspacePanes['ws-2']).toEqual([b]);
    // Only the active workspace's panes are on screen.
    expect(store().panes).toEqual([b]);
  });
});

describe('pane limit', () => {
  it('reflects the workspace maxParallelAgents and blocks past it', async () => {
    projectRef.workspaceConfig = { maxParallelAgents: 2 };
    expect(store().getMaxPaneLimit()).toBe(2);

    await store().addPane('/proj');
    expect(store().canAddPane()).toBe(true);
    await store().addPane('/proj');
    expect(store().canAddPane()).toBe(false);
  });

  it('falls back to the default limit when no config is present', () => {
    projectRef.workspaceConfig = null;
    expect(store().getMaxPaneLimit()).toBe(16);
  });
});

describe('removePane', () => {
  it('kills the PTY, drops the pane, and moves focus to a survivor', async () => {
    const a = await store().addPane('/proj');
    const b = await store().addPane('/proj'); // b is focused (added last)
    expect(store().focusedPaneId).toBe(b);

    await store().removePane(b);

    expect(invokeMock).toHaveBeenCalledWith('kill_pty', { id: b });
    expect(store().panes).toEqual([a]);
    expect(store().sessions[b]).toBeUndefined();
    expect(store().focusedPaneId).toBe(a);
  });

  it('drops the workspace bucket entirely when its last pane closes', async () => {
    const a = await store().addPane('/proj');
    await store().removePane(a);

    expect(store().workspacePanes['ws-1']).toBeUndefined();
    expect(store().panes).toEqual([]);
    expect(store().focusedPaneId).toBeNull();
  });
});

describe('confirmRemovePane', () => {
  beforeEach(() => {
    useConfirmStore.setState({ isOpen: false, onConfirm: null, onCancel: null });
  });

  it('asks for confirmation and only removes the live pane on confirm', async () => {
    const a = await store().addPane('/proj');

    store().confirmRemovePane(a);
    expect(useConfirmStore.getState().isOpen).toBe(true);
    expect(store().sessions[a]).toBeDefined();

    useConfirmStore.getState().onConfirm?.();
    await vi.waitFor(() => expect(store().sessions[a]).toBeUndefined());
    expect(invokeMock).toHaveBeenCalledWith('kill_pty', { id: a });
  });

  it('closes an already-exited pane without prompting', async () => {
    const a = await store().addPane('/proj');
    useTerminalStore.setState((s) => ({ exitedPanes: { ...s.exitedPanes, [a]: true } }));

    store().confirmRemovePane(a);
    expect(useConfirmStore.getState().isOpen).toBe(false);
    await vi.waitFor(() => expect(store().sessions[a]).toBeUndefined());
  });
});

describe('output buffering', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accumulates appended output and exposes it once flushed', async () => {
    const id = 'term-out';
    store().appendOutput(id, 'hello ');
    store().appendOutput(id, 'world');
    // Nothing is visible until the scheduled flush runs.
    expect(store().getBufferedOutput(id)).toBe('');

    vi.advanceTimersByTime(20);
    expect(store().getBufferedOutput(id)).toBe('hello world');
    expect(store().getLatestSequence(id)).toBeGreaterThan(0);
  });

  it('trims the retained buffer to the cap under sustained output', () => {
    const id = 'term-flood';
    store().appendOutput(id, 'x'.repeat(TERMINAL_OUTPUT_BUFFER_CHARS + 100_000));
    vi.advanceTimersByTime(20);

    expect(store().getBufferedOutput(id).length).toBe(TERMINAL_OUTPUT_BUFFER_CHARS);
  });
});

// The store is a dumb transport: PTY events are recorded (buffer + rolling tail) and re-emitted
// as RawTerminalEvents for terminalSwarmBridge. These tests pin that transport contract.
describe('raw transport events', () => {
  const tauriHandler = (topic: string) => {
    const call = listenMock.mock.calls.find(([t]) => t === topic);
    return call?.[1] as (event: { payload: unknown }) => void;
  };

  it('re-emits pty-output as a raw event with the tail already updated', async () => {
    await store().addPane('/proj');
    const events: RawTerminalEvent[] = [];
    const tailsDuringEvents: string[] = [];
    const unsubscribe = subscribeRawTerminalEvents((event) => {
      // The bridge reads the signal tail DURING the event for marker detection, so it must
      // already include the chunk that triggered this event.
      if (event.kind === 'output') {
        events.push(event);
        tailsDuringEvents.push(getPaneSignalTail(event.paneId));
      }
    });

    tauriHandler('pty-output')({ payload: { id: 'term-1', data: 'work [AGENT_' } });
    tauriHandler('pty-output')({ payload: { id: 'term-1', data: 'DONE]' } });

    unsubscribe();
    expect(events).toEqual([
      { kind: 'output', paneId: 'term-1', data: 'work [AGENT_' },
      { kind: 'output', paneId: 'term-1', data: 'DONE]' },
    ]);
    expect(tailsDuringEvents).toEqual(['work [AGENT_', 'work [AGENT_DONE]']);
  });

  it('re-emits pty-exit only for live sessions', async () => {
    const id = await store().addPane('/proj');
    const events: RawTerminalEvent[] = [];
    const unsubscribe = subscribeRawTerminalEvents(events.push.bind(events));

    tauriHandler('pty-exit')({ payload: { id: 'ghost-pane', exitCode: 0 } });
    expect(events).toEqual([]);

    tauriHandler('pty-exit')({ payload: { id, exitCode: 3 } });
    unsubscribe();

    expect(events).toEqual([{ kind: 'exit', paneId: id, exitCode: 3 }]);
    expect(store().exitedPanes[id]).toBe(true);
  });

  it('emits spawn-failed when the PTY listeners cannot start', async () => {
    listenMock.mockReset().mockRejectedValueOnce(new Error('listener registration failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const events: RawTerminalEvent[] = [];
      const unsubscribe = subscribeRawTerminalEvents(events.push.bind(events));

      const id = await store().addPane('/proj');
      unsubscribe();

      expect(store().exitedPanes[id]).toBe(true);
      expect(events).toEqual([
        { kind: 'spawn-failed', paneId: id, error: expect.any(Error) },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
