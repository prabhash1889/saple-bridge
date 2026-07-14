import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, Plus, RotateCw, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useProjectStore } from '../../stores/projectStore';
import { useConfirmStore } from '../../stores/confirmStore';
import { useShortcutsHelpStore } from '../../stores/shortcutsHelpStore';
import {
  initBrowserNavListener,
  MIN_PANEL_WIDTH,
  tabLabel,
  useBrowserStore,
} from '../../stores/browserStore';

// The pages themselves are native child webviews (browser.rs) that float above all DOM,
// positioned to cover `.browser-viewport`. This component renders everything around them
// (tab strip, toolbar, resizer), keeps the webview bounds glued to the placeholder, and
// hides the webviews whenever an app overlay (palette/dialogs) or another room is active.

const MAX_PANEL_FRACTION = 0.7;

export const BrowserPanel: React.FC = () => {
  const workspaceId = useProjectStore((state) => state.currentWorkspaceId);
  const activeView = useProjectStore((state) => state.activeView);
  const workspace = useBrowserStore((state) =>
    workspaceId ? state.workspaces[workspaceId] : undefined
  );
  const live = useBrowserStore((state) => state.live);
  const suppressed = useBrowserStore((state) => state.suppressed);
  const confirmOpen = useConfirmStore((state) => state.isOpen);
  const shortcutsOpen = useShortcutsHelpStore((state) => state.isOpen);

  const panelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const urlInputRef = useRef<HTMLInputElement>(null);
  // Non-null while the user is editing the URL bar; otherwise it mirrors the tab URL.
  const [draft, setDraft] = useState<string | null>(null);
  // Live width during a resizer drag; committed to the store on pointer-up.
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const tabs = workspace?.tabs ?? [];
  const activeTab = tabs.find((tab) => tab.id === workspace?.activeTabId);
  const activeTabLive = activeTab ? !!live[activeTab.id] : false;
  const visible =
    activeView === 'terminals' && !!workspace?.isOpen && !suppressed && !confirmOpen && !shortcutsOpen;
  const panelWidth = dragWidth ?? workspace?.panelWidth ?? MIN_PANEL_WIDTH;

  useEffect(() => {
    initBrowserNavListener();
  }, []);

  // Reset URL-bar editing when the active tab changes; focus it on blank new tabs.
  useEffect(() => {
    setDraft(null);
    if (activeTab && !activeTab.url) urlInputRef.current?.focus();
  }, [activeTab?.id, activeTab?.url]);

  // Lazily create the active tab's webview the first time it is shown (covers restored
  // sessions: persisted tabs are just URLs until viewed).
  useEffect(() => {
    if (!visible || !activeTab || !activeTab.url || activeTabLive) return;
    const el = viewportRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const tabId = activeTab.id;
    void invoke('browser_open_tab', {
      id: tabId,
      url: activeTab.url,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    })
      .then(() => useBrowserStore.getState().markLive(tabId))
      .catch((err) => console.error('Failed to open browser tab:', err));
  }, [visible, activeTab, activeTabLive]);

  // Show exactly the active tab's webview when the panel is visible, nothing otherwise.
  useEffect(() => {
    const activeId = visible && activeTab && activeTabLive ? activeTab.id : null;
    void invoke('browser_set_visible', { activeId }).catch(() => {});
  }, [visible, activeTab, activeTabLive]);

  // Hide all browser webviews when the panel unmounts (panel closed / workspace without
  // a browser activated). The webviews stay alive so reopening is instant.
  useEffect(
    () => () => {
      void invoke('browser_set_visible', { activeId: null }).catch(() => {});
    },
    []
  );

  // Keep webview bounds glued to the placeholder. ResizeObserver catches size changes
  // (divider drag, pane layout); the window listener catches position-only shifts
  // (window resize moves the panel's left edge without changing its width).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    let raf = 0;
    const send = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void invoke('browser_set_bounds', {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }).catch(() => {});
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(send);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(el);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Shift the toast stack left of the panel while the native webview would cover it.
  useEffect(() => {
    if (!visible) return;
    document.documentElement.style.setProperty('--browser-panel-width', `${panelWidth}px`);
    return () => {
      document.documentElement.style.removeProperty('--browser-panel-width');
    };
  }, [visible, panelWidth]);

  const handleResizerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const right = panel.getBoundingClientRect().right;
    const maxWidth = (panel.parentElement?.getBoundingClientRect().width ?? right) * MAX_PANEL_FRACTION;
    let width = panel.getBoundingClientRect().width;
    const onMove = (e: PointerEvent) => {
      width = Math.round(Math.min(Math.max(right - e.clientX, MIN_PANEL_WIDTH), maxWidth));
      setDragWidth(width);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const id = useProjectStore.getState().currentWorkspaceId;
      if (id) useBrowserStore.getState().setPanelWidth(id, width);
      setDragWidth(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  if (!workspaceId || !workspace) return null;

  const submitUrl = () => {
    const value = draft?.trim();
    if (!value || !activeTab) return;
    useBrowserStore.getState().navigate(workspaceId, activeTab.id, value);
    setDraft(null);
    urlInputRef.current?.blur();
  };

  return (
    <div className="browser-panel" ref={panelRef} style={{ width: panelWidth }}>
      <div
        className="browser-resizer"
        onPointerDown={handleResizerPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser panel"
      />
      <div className="browser-tabs" role="tablist">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`browser-tab ${tab.id === activeTab?.id ? 'active' : ''}`}
            role="tab"
            aria-selected={tab.id === activeTab?.id}
            title={tab.url || 'New tab'}
            onClick={() => useBrowserStore.getState().setActiveTab(workspaceId, tab.id)}
          >
            <span className="browser-tab-label">{tabLabel(tab.url)}</span>
            <button
              className="browser-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                useBrowserStore.getState().closeTab(workspaceId, tab.id);
              }}
              title="Close tab"
              aria-label={`Close ${tabLabel(tab.url)}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          className="browser-tab-new"
          onClick={() => useBrowserStore.getState().newTab(workspaceId)}
          title="New tab"
          aria-label="New tab"
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="browser-toolbar">
        <button
          className="browser-toolbar-btn"
          onClick={() => activeTab && useBrowserStore.getState().goBack(activeTab.id)}
          disabled={!activeTabLive}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          className="browser-toolbar-btn"
          onClick={() => activeTab && useBrowserStore.getState().goForward(activeTab.id)}
          disabled={!activeTabLive}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRight size={15} />
        </button>
        <button
          className={`browser-toolbar-btn ${activeTab?.loading ? 'browser-loading' : ''}`}
          onClick={() => activeTab && useBrowserStore.getState().reload(activeTab.id)}
          disabled={!activeTabLive}
          title="Reload"
          aria-label="Reload"
        >
          <RotateCw size={14} />
        </button>
        <input
          ref={urlInputRef}
          className="browser-url-input"
          value={draft ?? activeTab?.url ?? ''}
          placeholder="Search or enter address"
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitUrl();
            if (e.key === 'Escape') {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          aria-label="Address"
        />
        <button
          className="browser-toolbar-btn"
          onClick={() => activeTab?.url && void openUrl(activeTab.url)}
          disabled={!activeTab?.url}
          title="Open in system browser"
          aria-label="Open in system browser"
        >
          <ExternalLink size={14} />
        </button>
        <button
          className="browser-toolbar-btn"
          onClick={() => useBrowserStore.getState().closePanel(workspaceId)}
          title="Close browser panel"
          aria-label="Close browser panel"
        >
          <X size={15} />
        </button>
      </div>
      <div className="browser-viewport" ref={viewportRef}>
        {activeTab && !activeTab.url && (
          <div className="browser-empty-state">
            <p>Enter a URL or search above to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
};
