import { describe, it, expect, vi, beforeEach } from 'vitest';

// browserStore only touches Tauri IPC for webview lifecycle; mock it so the pure state
// logic — per-workspace tab bucketing, active-tab resolution, URL normalization — runs
// without a webview.
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

import { normalizeUrl, tabLabel, useBrowserStore } from './browserStore';

const store = () => useBrowserStore.getState();

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(undefined);
  useBrowserStore.setState({ workspaces: {}, live: {}, suppressed: false });
});

describe('normalizeUrl', () => {
  it('keeps explicit schemes', () => {
    expect(normalizeUrl('https://github.com')).toBe('https://github.com');
    expect(normalizeUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });

  it('defaults local hosts to http', () => {
    expect(normalizeUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeUrl('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
  });

  it('defaults host-looking input to https', () => {
    expect(normalizeUrl('github.com')).toBe('https://github.com');
    expect(normalizeUrl('docs.rs/tauri/latest')).toBe('https://docs.rs/tauri/latest');
  });

  it('treats everything else as a web search', () => {
    expect(normalizeUrl('tauri child webview')).toBe(
      'https://www.google.com/search?q=tauri%20child%20webview'
    );
  });

  it('returns empty for blank input', () => {
    expect(normalizeUrl('   ')).toBe('');
  });
});

describe('tabLabel', () => {
  it('shows the hostname for URLs and a fallback for blank tabs', () => {
    expect(tabLabel('https://github.com/tauri-apps/tauri')).toBe('github.com');
    expect(tabLabel('')).toBe('New tab');
    expect(tabLabel('not a url')).toBe('not a url');
  });
});

describe('tabs per workspace', () => {
  it('openPanel seeds a blank tab and is idempotent on the session', () => {
    store().openPanel('ws-1');
    const ws = store().workspaces['ws-1'];
    expect(ws.isOpen).toBe(true);
    expect(ws.tabs).toHaveLength(1);
    expect(ws.activeTabId).toBe(ws.tabs[0].id);

    store().closePanel('ws-1');
    store().openPanel('ws-1');
    expect(store().workspaces['ws-1'].tabs).toHaveLength(1);
  });

  it('keeps workspaces isolated', () => {
    store().newTab('ws-1', 'https://a.com');
    store().newTab('ws-2', 'https://b.com');
    expect(store().workspaces['ws-1'].tabs.map((t) => t.url)).toEqual(['https://a.com']);
    expect(store().workspaces['ws-2'].tabs.map((t) => t.url)).toEqual(['https://b.com']);
  });

  it('closing the active tab activates its neighbor; closing the last tab closes the panel', () => {
    store().newTab('ws-1', 'https://a.com');
    store().newTab('ws-1', 'https://b.com');
    const [a, b] = store().workspaces['ws-1'].tabs;
    expect(store().workspaces['ws-1'].activeTabId).toBe(b.id);

    store().closeTab('ws-1', b.id);
    expect(store().workspaces['ws-1'].activeTabId).toBe(a.id);
    expect(store().workspaces['ws-1'].isOpen).toBe(true);

    store().closeTab('ws-1', a.id);
    expect(store().workspaces['ws-1'].tabs).toHaveLength(0);
    expect(store().workspaces['ws-1'].isOpen).toBe(false);
  });

  it('closing a live tab tears down its webview', () => {
    store().newTab('ws-1', 'https://a.com');
    const tab = store().workspaces['ws-1'].tabs[0];
    store().markLive(tab.id);

    store().closeTab('ws-1', tab.id);
    expect(invokeMock).toHaveBeenCalledWith('browser_close_tab', { id: tab.id });
    expect(store().live[tab.id]).toBeUndefined();
  });
});

describe('navigate', () => {
  it('updates the tab URL and only invokes navigation for live tabs', () => {
    store().newTab('ws-1', '');
    const tab = store().workspaces['ws-1'].tabs[0];

    store().navigate('ws-1', tab.id, 'github.com');
    expect(store().workspaces['ws-1'].tabs[0].url).toBe('https://github.com');
    expect(invokeMock).not.toHaveBeenCalledWith('browser_navigate', expect.anything());

    store().markLive(tab.id);
    store().navigate('ws-1', tab.id, 'docs.rs');
    expect(invokeMock).toHaveBeenCalledWith('browser_navigate', {
      id: tab.id,
      url: 'https://docs.rs',
    });
  });
});

describe('closeWorkspaceBrowser', () => {
  it('closes live webviews and forgets the workspace session', async () => {
    store().newTab('ws-1', 'https://a.com');
    store().newTab('ws-1', 'https://b.com');
    const [a] = store().workspaces['ws-1'].tabs;
    store().markLive(a.id);

    await store().closeWorkspaceBrowser('ws-1');
    expect(invokeMock).toHaveBeenCalledWith('browser_close_tab', { id: a.id });
    expect(store().workspaces['ws-1']).toBeUndefined();
    expect(store().live[a.id]).toBeUndefined();
  });
});
