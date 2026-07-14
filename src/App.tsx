import { lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Sidebar } from './components/layout/Sidebar';
import { TopBar } from './components/layout/TopBar';
import { StatusBar } from './components/layout/StatusBar';
import { ProjectDashboard } from './components/project/ProjectDashboard';
import { ToastHost } from './components/common/ToastHost';
import { ConfirmDialog } from './components/common/ConfirmDialog';
import { ShortcutsHelpDialog } from './components/common/ShortcutsHelpDialog';
import { RoomSkeleton } from './components/common/RoomSkeleton';
import { useProjectStore, ViewType } from './stores/projectStore';
import { useKanbanStore } from './stores/kanbanStore';
import { useSwarmStore } from './stores/swarmStore';
import { useAgentSessionStore } from './stores/agentSessionStore';
import { useTerminalStore } from './stores/terminalStore';
import { useBrowserStore } from './stores/browserStore';
import { useFileStore } from './stores/fileStore';
import { useNotificationStore } from './stores/notificationStore';
import { useThemeStore, resolveTheme } from './stores/themeStore';
import { startJuneDispatcher } from './lib/juneDispatcher';

const TerminalGrid = lazy(() => import('./components/terminal/TerminalGrid').then((module) => ({ default: module.TerminalGrid })));
const KanbanBoard = lazy(() => import('./components/kanban/KanbanBoard').then((module) => ({ default: module.KanbanBoard })));
const ProjectSettings = lazy(() => import('./components/project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const MemoryWorkspace = lazy(() => import('./components/memory/MemoryWorkspace').then((module) => ({ default: module.MemoryWorkspace })));
const SwarmWorkspace = lazy(() => import('./components/swarm/SwarmWorkspace').then((module) => ({ default: module.SwarmWorkspace })));
const ReviewWorkspace = lazy(() => import('./components/review/ReviewWorkspace').then((module) => ({ default: module.ReviewWorkspace })));
const EditorPanel = lazy(() => import('./components/editor/EditorPanel').then((module) => ({ default: module.EditorPanel })));
const CommandPalette = lazy(() => import('./components/common/CommandPalette').then((module) => ({ default: module.CommandPalette })));
const PreviewPanel = lazy(() => import('./components/preview/PreviewPanel').then((module) => ({ default: module.PreviewPanel })));

// Heavy, stateful views are kept mounted once first visited and toggled with CSS
// visibility, so switching back is instant (no remount, no xterm dispose/replay).
// Light views (dashboard, editor, settings) render on demand.
const HEAVY_VIEWS: ViewType[] = ['terminals', 'kanban', 'memory', 'swarm', 'review'];

function App() {
  const activeView = useProjectStore((state) => state.activeView);
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const currentWorkspaceId = useProjectStore((state) => state.currentWorkspaceId);
  const refreshWorkspace = useProjectStore((state) => state.refreshWorkspace);
  const loadTasks = useKanbanStore((state) => state.loadTasks);
  const loadSwarmState = useSwarmStore((state) => state.loadSwarmState);
  const loadAgentSessions = useAgentSessionStore((state) => state.loadSessions);
  const activateTerminalWorkspace = useTerminalStore((state) => state.activateWorkspace);
  const restoreFileLayout = useFileStore((state) => state.restoreLayout);

  const themeMode = useThemeStore((state) => state.mode);

  const [paletteOpen, setPaletteOpen] = useState(false);
  // When the palette was opened via the composer shortcut, it starts on the target picker.
  const [paletteCompose, setPaletteCompose] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mountedHeavyViews, setMountedHeavyViews] = useState<Set<ViewType>>(() => new Set<ViewType>());
  const hideTopBar = HEAVY_VIEWS.includes(activeView);

  // Apply the resolved theme, and when following the OS, react to system changes.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveTheme(themeMode));
    if (themeMode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [themeMode]);

  // The command palette floats over the browser region; native browser webviews render
  // above all DOM, so they must hide while the palette is open (see browserStore.suppressed).
  useEffect(() => {
    useBrowserStore.getState().setSuppressed(paletteOpen);
  }, [paletteOpen]);

  // Listen for June control commands (no-op unless the user enabled the endpoint). See
  // juneDispatcher.ts and src-tauri/src/june_control.rs.
  useEffect(() => {
    const unlisten = startJuneDispatcher();
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (HEAVY_VIEWS.includes(activeView)) {
      setMountedHeavyViews((prev) => (prev.has(activeView) ? prev : new Set(prev).add(activeView)));
    }
  }, [activeView]);

  useEffect(() => {
    // Terminals are scoped per workspace instance, so activate by id (two openings of the
    // same folder have the same path but different ids and independent pane sets).
    activateTerminalWorkspace(currentWorkspaceId);
    // Restore this workspace's persisted Files-room layout (expanded folders + open tabs), or clear
    // when there's no project. Replaces the previous unconditional reset so the tree/tabs survive
    // project switches and restart (P12).
    restoreFileLayout(currentProjectPath);
    if (!currentProjectPath) {
      void invoke('unwatch_project_files').catch(() => {});
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      void loadTasks(currentProjectPath);
      // force: re-read disk state on every project open (persisted loadedProjectPath
      // would otherwise short-circuit and keep stale localStorage swarm state).
      void loadSwarmState(currentProjectPath, true);
      void loadAgentSessions(currentProjectPath);
      void refreshWorkspace();
      // Follow the active project with a Rust file watcher so external .saple edits (MCP
      // sidecar, agents) force-reload these stores before the next save clobbers them.
      void invoke('watch_project_files', { projectPath: currentProjectPath }).catch(() => {});
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentWorkspaceId, currentProjectPath, refreshWorkspace, loadSwarmState, loadTasks, loadAgentSessions, activateTerminalWorkspace, restoreFileLayout]);

  // External edits to .saple state (from the MCP sidecar / agents) arrive as `saple-file-changed`.
  // Force-reload the affected store so the in-memory copy matches disk before the next save. Read
  // the current path via getState so a stale closure can't reload into the wrong (switched) project.
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    void listen<{ file: string; projectPath: string }>('saple-file-changed', (event) => {
      const { file, projectPath } = event.payload;
      if (projectPath !== useProjectStore.getState().currentProjectPath) return;
      if (file === 'tasks') void useKanbanStore.getState().loadTasks(projectPath, true);
      else if (file === 'swarm') void useSwarmStore.getState().loadSwarmState(projectPath, true);
      else if (file === 'sessions') void useAgentSessionStore.getState().loadSessions(projectPath, true);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    const handleNewTerminal = async () => {
      const { currentProjectPath, setActiveView } = useProjectStore.getState();
      if (!currentProjectPath) return;
      try {
        await useTerminalStore.getState().addPane(currentProjectPath);
        setActiveView('terminals');
      } catch (err) {
        useNotificationStore.getState().error(`Failed to create terminal: ${String(err)}`);
      }
    };

    const focusNextTerminal = () => {
      const { panes, focusedPaneId, setFocusedPane } = useTerminalStore.getState();
      if (panes.length === 0) return;
      const currentIndex = panes.indexOf(focusedPaneId || '');
      const nextIndex = (currentIndex + 1) % panes.length;
      setFocusedPane(panes[nextIndex]);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Command Palette: Ctrl+P / Cmd+P
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setPaletteCompose(false);
        setPaletteOpen((prev) => !prev);
      }

      // 2. Open Command Palette: Ctrl+Shift+P / Cmd+Shift+P
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setPaletteCompose(false);
        setPaletteOpen(true);
      }

      // 2b. Open the composer: Ctrl+Shift+K / Cmd+Shift+K
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteCompose(true);
        setPaletteOpen(true);
      }

      // 2c. Toggle the Local Preview drawer: Ctrl+Shift+B / Cmd+Shift+B (P5)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setPreviewOpen((prev) => !prev);
      }

      // 3. Switch rooms: Alt + 1-9
      if (e.altKey && e.key >= '1' && e.key <= '9') {
        const index = parseInt(e.key, 10) - 1;
        const rooms: ViewType[] = ['dashboard', 'terminals', 'kanban', 'memory', 'swarm', 'review', 'editor', 'settings'];
        const view = rooms[index];
        if (view) {
          const requiresProject = ['terminals', 'kanban', 'memory', 'swarm', 'review', 'editor'].includes(view);
          if (!requiresProject || currentProjectPath) {
            e.preventDefault();
            useProjectStore.getState().setActiveView(view);
          }
        }
      }

      // 4. New terminal: Ctrl+Shift+T / Ctrl+Alt+T
      if (((e.ctrlKey && e.shiftKey) || (e.ctrlKey && e.altKey)) && e.key.toLowerCase() === 't') {
        e.preventDefault();
        handleNewTerminal();
      }

      // 5. Focus next terminal: Ctrl+Shift+Tab or Ctrl+Alt+Right
      if ((e.ctrlKey && e.altKey && e.key === 'ArrowRight') || (e.ctrlKey && e.shiftKey && e.key === 'Tab')) {
        e.preventDefault();
        focusNextTerminal();
      }

      // 6. Open review queue: Ctrl+Shift+R
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (currentProjectPath) {
          useProjectStore.getState().setActiveView('review');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentProjectPath]);

  // The Command Palette's "Open Local Preview" entry dispatches this so it doesn't need the
  // overlay's setter (decoupled, same pattern the palette uses to reach the shell).
  useEffect(() => {
    const open = () => setPreviewOpen(true);
    window.addEventListener('open-local-preview', open);
    return () => window.removeEventListener('open-local-preview', open);
  }, []);

  const renderHeavyView = (view: ViewType, node: ReactNode) => {
    if (!mountedHeavyViews.has(view)) return null;
    const isActive = activeView === view;
    return (
      <div key={view} className={`view-pane${isActive ? '' : ' is-hidden'}`} aria-hidden={!isActive}>
        <Suspense fallback={isActive ? <RoomSkeleton /> : null}>
          {node}
        </Suspense>
      </div>
    );
  };

  const renderLightView = () => {
    switch (activeView) {
      case 'editor':
        return <EditorPanel />;
      case 'settings':
        return <ProjectSettings />;
      case 'dashboard':
      default:
        return <ProjectDashboard />;
    }
  };

  return (
    <div className={`app-grid ${hideTopBar ? 'no-topbar' : ''}`}>
      <Sidebar onOpenPalette={() => { setPaletteCompose(false); setPaletteOpen(true); }} />
      {!hideTopBar && <TopBar />}
      <main className="content-area">
        {renderHeavyView('terminals', <TerminalGrid />)}
        {renderHeavyView('kanban', <KanbanBoard />)}
        {renderHeavyView('memory', <MemoryWorkspace />)}
        {renderHeavyView('swarm', <SwarmWorkspace />)}
        {renderHeavyView('review', <ReviewWorkspace />)}
        {!HEAVY_VIEWS.includes(activeView) && (
          <div className="view-pane">
            <Suspense fallback={<RoomSkeleton />}>
              {renderLightView()}
            </Suspense>
          </div>
        )}
      </main>
      <StatusBar />
      <ToastHost />
      <ConfirmDialog />
      <ShortcutsHelpDialog />
      {paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette isOpen={paletteOpen} initialCompose={paletteCompose} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
      {previewOpen && (
        <Suspense fallback={null}>
          <PreviewPanel isOpen={previewOpen} onClose={() => setPreviewOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
