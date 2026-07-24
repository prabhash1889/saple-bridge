import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useProjectStore } from './projectStore';

// Embedded browser state, per workspace instance (mirrors terminalStore's workspace maps):
// each workspace has its own tabs/active tab/panel width, persisted so a restart restores
// the session. The actual pages are native child webviews owned by Rust (browser.rs) and
// labeled `browser-<tabId>`; this store owns which tabs exist. Webview creation is lazy and
// bounds-dependent, so it lives in BrowserPanel — `live` tracks which tabs have a webview.

export interface BrowserTab {
  id: string;
  /** Current URL ('' = blank new tab, no webview yet). */
  url: string;
  loading: boolean;
}

export interface WorkspaceBrowser {
  isOpen: boolean;
  tabs: BrowserTab[];
  activeTabId: string | null;
  panelWidth: number;
}

export const DEFAULT_PANEL_WIDTH = 520;
export const MIN_PANEL_WIDTH = 300;

/**
 * Turn URL-bar input into a navigable URL: keep explicit schemes, default local hosts to
 * http, host-looking input to https, and treat everything else as a web search.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/.test(trimmed)) return `http://${trimmed}`;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (!/\s/.test(trimmed) && /^[^\s/]+\.[^\s]{2,}/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

/** Tab strip label: hostname for http(s) URLs, the raw URL otherwise, 'New tab' for blank. */
export function tabLabel(url: string): string {
  if (!url) return 'New tab';
  try {
    const parsed = new URL(url);
    return parsed.hostname || url;
  } catch {
    return url;
  }
}

const emptyWorkspace = (): WorkspaceBrowser => ({
  isOpen: false,
  tabs: [],
  activeTabId: null,
  panelWidth: DEFAULT_PANEL_WIDTH,
});

const newTabObject = (url: string): BrowserTab => ({
  id: crypto.randomUUID(),
  url,
  loading: false,
});

interface BrowserState {
  workspaces: Record<string, WorkspaceBrowser>;
  /** Tab ids that currently have a native webview (runtime only, not persisted). */
  live: Record<string, boolean>;
  /** True while an app overlay (command palette) must cover the browser region. */
  suppressed: boolean;

  openPanel: (workspaceId: string) => void;
  closePanel: (workspaceId: string) => void;
  newTab: (workspaceId: string, url?: string) => void;
  closeTab: (workspaceId: string, tabId: string) => void;
  setActiveTab: (workspaceId: string, tabId: string) => void;
  navigate: (workspaceId: string, tabId: string, input: string) => void;
  goBack: (tabId: string) => void;
  goForward: (tabId: string) => void;
  reload: (tabId: string) => void;
  setPanelWidth: (workspaceId: string, width: number) => void;
  setSuppressed: (suppressed: boolean) => void;
  /** BrowserPanel calls this after browser_open_tab succeeds. */
  markLive: (tabId: string) => void;
  markDead: (tabId: string) => void;
  /** Tear down a closing workspace's webviews and forget its session. */
  closeWorkspaceBrowser: (workspaceId: string) => Promise<void>;
}

const closeTabWebview = (tabId: string) => {
  void invoke('browser_close_tab', { id: tabId }).catch(() => {
    // Already gone (never created, or window teardown) — nothing to clean up.
  });
};

export const useBrowserStore = create<BrowserState>()(
  persist(
    (set, get) => ({
      workspaces: {},
      live: {},
      suppressed: false,

      openPanel: (workspaceId) =>
        set((state) => {
          const ws = state.workspaces[workspaceId] ?? emptyWorkspace();
          const tabs = ws.tabs.length > 0 ? ws.tabs : [newTabObject('')];
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...ws,
                isOpen: true,
                tabs,
                activeTabId: ws.activeTabId ?? tabs[0].id,
              },
            },
          };
        }),

      closePanel: (workspaceId) =>
        set((state) => {
          const ws = state.workspaces[workspaceId];
          if (!ws) return state;
          return {
            workspaces: { ...state.workspaces, [workspaceId]: { ...ws, isOpen: false } },
          };
        }),

      newTab: (workspaceId, url = '') =>
        set((state) => {
          const ws = state.workspaces[workspaceId] ?? emptyWorkspace();
          const tab = newTabObject(url);
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...ws,
                isOpen: true,
                tabs: [...ws.tabs, tab],
                activeTabId: tab.id,
              },
            },
          };
        }),

      closeTab: (workspaceId, tabId) => {
        if (get().live[tabId]) closeTabWebview(tabId);
        set((state) => {
          const ws = state.workspaces[workspaceId];
          if (!ws) return state;
          const index = ws.tabs.findIndex((tab) => tab.id === tabId);
          if (index === -1) return state;
          const tabs = ws.tabs.filter((tab) => tab.id !== tabId);
          const live = { ...state.live };
          delete live[tabId];
          // Closing the last tab closes the panel (like closing a browser window).
          const activeTabId =
            ws.activeTabId === tabId
              ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
              : ws.activeTabId;
          return {
            live,
            workspaces: {
              ...state.workspaces,
              [workspaceId]: { ...ws, tabs, activeTabId, isOpen: ws.isOpen && tabs.length > 0 },
            },
          };
        });
      },

      setActiveTab: (workspaceId, tabId) =>
        set((state) => {
          const ws = state.workspaces[workspaceId];
          if (!ws || !ws.tabs.some((tab) => tab.id === tabId)) return state;
          return {
            workspaces: { ...state.workspaces, [workspaceId]: { ...ws, activeTabId: tabId } },
          };
        }),

      navigate: (workspaceId, tabId, input) => {
        const url = normalizeUrl(input);
        if (!url) return;
        set((state) => {
          const ws = state.workspaces[workspaceId];
          if (!ws) return state;
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...ws,
                tabs: ws.tabs.map((tab) => (tab.id === tabId ? { ...tab, url, loading: true } : tab)),
              },
            },
          };
        });
        // A not-yet-live tab just keeps the new URL; BrowserPanel creates its webview with it.
        if (get().live[tabId]) {
          void invoke('browser_navigate', { id: tabId, url }).catch((err) => {
            console.error('Failed to navigate browser tab:', err);
          });
        }
      },

      goBack: (tabId) => {
        if (get().live[tabId]) void invoke('browser_back', { id: tabId }).catch(() => {});
      },
      goForward: (tabId) => {
        if (get().live[tabId]) void invoke('browser_forward', { id: tabId }).catch(() => {});
      },
      reload: (tabId) => {
        if (get().live[tabId]) void invoke('browser_reload', { id: tabId }).catch(() => {});
      },

      setPanelWidth: (workspaceId, width) =>
        set((state) => {
          const ws = state.workspaces[workspaceId];
          if (!ws) return state;
          return {
            workspaces: { ...state.workspaces, [workspaceId]: { ...ws, panelWidth: width } },
          };
        }),

      setSuppressed: (suppressed) => set({ suppressed }),

      markLive: (tabId) => set((state) => ({ live: { ...state.live, [tabId]: true } })),
      markDead: (tabId) =>
        set((state) => {
          const live = { ...state.live };
          delete live[tabId];
          return { live };
        }),

      closeWorkspaceBrowser: async (workspaceId) => {
        const ws = get().workspaces[workspaceId];
        if (!ws) return;
        for (const tab of ws.tabs) {
          if (get().live[tab.id]) closeTabWebview(tab.id);
        }
        set((state) => {
          const workspaces = { ...state.workspaces };
          delete workspaces[workspaceId];
          const live = { ...state.live };
          for (const tab of ws.tabs) delete live[tab.id];
          return { workspaces, live };
        });
      },
    }),
    {
      name: 'saple-bridge-browser-store',
      // Only the session data persists; webview liveness and overlay suppression are runtime.
      partialize: (state) => ({
        workspaces: Object.fromEntries(
          Object.entries(state.workspaces).map(([id, ws]) => [
            id,
            { ...ws, tabs: ws.tabs.map((tab) => ({ ...tab, loading: false })) },
          ])
        ),
      }),
    }
  )
);

/**
 * Open a link in the built-in browser panel (new tab in the current workspace) instead of
 * the OS browser. Falls back to the OS for non-web schemes (mailto:) or when no workspace
 * is active. Switches to the terminals view - the browser panel only renders there.
 */
export function openLink(url: string) {
  const workspaceId = useProjectStore.getState().currentWorkspaceId;
  if (!workspaceId || !/^https?:\/\//i.test(url)) {
    void openUrl(url).catch((err) => console.error('Failed to open URL:', err));
    return;
  }
  useProjectStore.getState().setActiveView('terminals');
  useBrowserStore.getState().newTab(workspaceId, url);
}

// Rust pushes every navigation (link clicks, redirects, back/forward) here so the URL bar
// and tab labels track the page without polling. Initialized once from BrowserPanel.
let navListenerStarted = false;
export function initBrowserNavListener() {
  if (navListenerStarted) return;
  navListenerStarted = true;
  void listen<{ id: string; url: string; loading: boolean }>('browser-tab-nav', (event) => {
    const { id, url, loading } = event.payload;
    useBrowserStore.setState((state) => {
      for (const [workspaceId, ws] of Object.entries(state.workspaces)) {
        if (ws.tabs.some((tab) => tab.id === id)) {
          return {
            workspaces: {
              ...state.workspaces,
              [workspaceId]: {
                ...ws,
                tabs: ws.tabs.map((tab) => (tab.id === id ? { ...tab, url, loading } : tab)),
              },
            },
          };
        }
      }
      return state;
    });
  });
}
