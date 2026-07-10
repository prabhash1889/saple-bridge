import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TERMINAL_OUTPUT_BUFFER_CHARS } from '../lib/terminalLimits';

// terminalStore reaches into Tauri IPC and several sibling stores. Mock all of them so the pure
// state logic — workspace bucketing, focus resolution, output buffering/trimming, pane limits —
// runs without a webview or a real PTY.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

const projectRef = vi.hoisted(() => ({
  currentProjectPath: '/proj' as string | null,
  currentWorkspaceId: 'ws-1' as string | null,
  workspaceConfig: { maxParallelAgents: 16 } as { maxParallelAgents: number } | null,
}));
vi.mock('./projectStore', () => ({
  useProjectStore: { getState: () => projectRef },
}));

vi.mock('./kanbanStore', () => ({
  useKanbanStore: { getState: () => ({ tasks: [], updateTask: vi.fn() }) },
}));

const layoutMock = vi.hoisted(() => ({
  setLayout: vi.fn(),
  clearLayout: vi.fn(),
  savedLayouts: {} as Record<string, unknown>,
}));
vi.mock('./terminalLayoutStore', () => ({
  useTerminalLayoutStore: { getState: () => layoutMock },
}));

vi.mock('../lib/desktopNotifications', () => ({
  notifyTaskReadyForReview: vi.fn(),
}));

import { useTerminalStore } from './terminalStore';

const store = () => useTerminalStore.getState();

beforeEach(async () => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  layoutMock.setLayout.mockReset();
  layoutMock.clearLayout.mockReset();
  projectRef.currentProjectPath = '/proj';
  projectRef.currentWorkspaceId = 'ws-1';
  projectRef.workspaceConfig = { maxParallelAgents: 16 };
  await store().clearAll();
});

describe('addPane', () => {
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
