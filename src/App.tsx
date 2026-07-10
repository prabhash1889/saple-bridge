import { lazy, Suspense, useState, useEffect, type ReactNode } from 'react';
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
import { useFileStore } from './stores/fileStore';
import { useNotificationStore } from './stores/notificationStore';
import { useThemeStore, resolveTheme } from './stores/themeStore';

const TerminalGrid = lazy(() => import('./components/terminal/TerminalGrid').then((module) => ({ default: module.TerminalGrid })));
const KanbanBoard = lazy(() => import('./components/kanban/KanbanBoard').then((module) => ({ default: module.KanbanBoard })));
const ProjectSettings = lazy(() => import('./components/project/ProjectSettings').then((module) => ({ default: module.ProjectSettings })));
const MemoryWorkspace = lazy(() => import('./components/memory/MemoryWorkspace').then((module) => ({ default: module.MemoryWorkspace })));
const SwarmWorkspace = lazy(() => import('./components/swarm/SwarmWorkspace').then((module) => ({ default: module.SwarmWorkspace })));
const ReviewWorkspace = lazy(() => import('./components/review/ReviewWorkspace').then((module) => ({ default: module.ReviewWorkspace })));
const EditorPanel = lazy(() => import('./components/editor/EditorPanel').then((module) => ({ default: module.EditorPanel })));
const CommandPalette = lazy(() => import('./components/common/CommandPalette').then((module) => ({ default: module.CommandPalette })));

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
  const resetFiles = useFileStore((state) => state.reset);

  const themeMode = useThemeStore((state) => state.mode);

  const [paletteOpen, setPaletteOpen] = useState(false);
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

  useEffect(() => {
    if (HEAVY_VIEWS.includes(activeView)) {
      setMountedHeavyViews((prev) => (prev.has(activeView) ? prev : new Set(prev).add(activeView)));
    }
  }, [activeView]);

  useEffect(() => {
    // Terminals are scoped per workspace instance, so activate by id (two openings of the
    // same folder have the same path but different ids and independent pane sets).
    activateTerminalWorkspace(currentWorkspaceId);
    // Drop the previous workspace's open file/tree so the viewer doesn't show stale content.
    resetFiles();
    if (!currentProjectPath) return;

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled) return;
      void loadTasks(currentProjectPath);
      // force: re-read disk state on every project open (persisted loadedProjectPath
      // would otherwise short-circuit and keep stale localStorage swarm state).
      void loadSwarmState(currentProjectPath, true);
      void loadAgentSessions(currentProjectPath);
      void refreshWorkspace();
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [currentWorkspaceId, currentProjectPath, refreshWorkspace, loadSwarmState, loadTasks, loadAgentSessions, activateTerminalWorkspace, resetFiles]);

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
        setPaletteOpen((prev) => !prev);
      }

      // 2. Open Command Palette: Ctrl+Shift+P / Cmd+Shift+P
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
        e.preventDefault();
        setPaletteOpen(true);
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
      <Sidebar onOpenPalette={() => setPaletteOpen(true)} />
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
          <CommandPalette isOpen={paletteOpen} onClose={() => setPaletteOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}

export default App;
