import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronsUpDown,
  History,
  Home,
  Plus,
  Settings,
  FileCode,
  X,
  Bot,
  Split,
  Trash2,
  Edit3,
  Tag,
  Minimize2,
  Maximize2,
  Command,
  Terminal as TerminalIcon,
  FolderOpen,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore, ViewType } from '../../stores/projectStore';
import { useSwarmStore } from '../../stores/swarmStore';
import { useTerminalStore, AiProvider } from '../../stores/terminalStore';
import { useTerminalFontStore, TERMINAL_FONT_OPTIONS } from '../../stores/terminalFontStore';
import bridgeMark from '../../assets/logo/saple-bridge-mark.png';

interface SidebarProps {
  onOpenPalette?: () => void;
}

const COLOR_PRESETS = [
  { value: '#5D5FEF', label: 'Indigo' },
  { value: '#10B981', label: 'Green' },
  { value: '#EF4444', label: 'Red' },
  { value: '#F59E0B', label: 'Orange' },
  { value: '#3B82F6', label: 'Blue' },
  { value: '#EC4899', label: 'Pink' },
  { value: '#8B5CF6', label: 'Violet' },
  { value: '#14B8A6', label: 'Teal' },
  { value: '#06B6D4', label: 'Cyan' },
  { value: '#22C55E', label: 'Emerald' },
  { value: '#84CC16', label: 'Lime' },
  { value: '#EAB308', label: 'Yellow' },
  { value: '#F97316', label: 'Amber' },
  { value: '#F43F5E', label: 'Rose' },
  { value: '#D946EF', label: 'Fuchsia' },
  { value: '#A855F7', label: 'Purple' },
  { value: '#0EA5E9', label: 'Sky' },
  { value: '#64748B', label: 'Slate' },
  { value: '#78716C', label: 'Stone' },
  { value: '#DC2626', label: 'Crimson' },
  { value: '#059669', label: 'Pine' },
];

const AI_PROVIDERS: { value: AiProvider; label: string; icon: string }[] = [
  { value: 'claude', label: 'Claude', icon: 'Cl' },
  { value: 'codex', label: 'Codex', icon: 'C' },
  { value: 'droid', label: 'Droid', icon: 'D' },
  { value: 'pi', label: 'Pi', icon: 'Pi' },
  { value: 'opencode', label: 'OpenCode', icon: 'O' },
  { value: 'custom', label: 'Custom', icon: 'Cu' },
];


const primaryNavItems: Array<{ id: ViewType; label: string; icon: React.ElementType; accent: string }> = [
  { id: 'dashboard', label: 'Home', icon: Home, accent: 'home' },
];

const secondaryNavItems: Array<{ id: ViewType; label: string; icon: React.ElementType; accent: string }> = [
  { id: 'editor', label: 'Files', icon: FileCode, accent: 'editor' },
  { id: 'settings', label: 'Settings', icon: Settings, accent: 'settings' },
];

const workspaceRooms: ViewType[] = ['terminals', 'kanban', 'memory', 'swarm', 'review', 'editor'];

export const Sidebar: React.FC<SidebarProps> = ({ onOpenPalette }) => {
  const activeView = useProjectStore((state) => state.activeView);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const currentWorkspaceId = useProjectStore((state) => state.currentWorkspaceId);
  const openWorkspaces = useProjectStore((state) => state.openWorkspaces);
  const addWorkspace = useProjectStore((state) => state.addWorkspace);
  const openWorkspaceInstance = useProjectStore((state) => state.openWorkspaceInstance);
  const workspaceLoading = useProjectStore((state) => state.workspaceLoading);
  const closeWorkspace = useProjectStore((state) => state.closeWorkspace);

  const [selectedProvider, setSelectedProvider] = useState<AiProvider>('claude');
  const [controlsCollapsed, setControlsCollapsed] = useState(true);
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerPickerRef = useRef<HTMLDivElement>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState<{ x: number; y: number; path: string } | null>(null);

  const panes = useTerminalStore((state) => state.panes);
  const focusedPaneId = useTerminalStore((state) => state.focusedPaneId);
  const maximizedPaneId = useTerminalStore((state) => state.maximizedPaneId);
  const focusedSession = useTerminalStore((state) =>
    state.focusedPaneId ? state.sessions[state.focusedPaneId] : null
  );
  const addPane = useTerminalStore((state) => state.addPane);
  const splitPane = useTerminalStore((state) => state.splitPane);
  const removePane = useTerminalStore((state) => state.removePane);
  const updateSession = useTerminalStore((state) => state.updateSession);
  const canAddPane = useTerminalStore((state) => state.canAddPane);
  const getMaxPaneLimit = useTerminalStore((state) => state.getMaxPaneLimit);
  const toggleMaximizePane = useTerminalStore((state) => state.toggleMaximizePane);

  const fontId = useTerminalFontStore((state) => state.fontId);
  const setFontId = useTerminalFontStore((state) => state.setFontId);

  const maxLimit = getMaxPaneLimit();
  const atMax = !canAddPane();

  useEffect(() => {
    if (!providerMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!providerPickerRef.current?.contains(event.target as Node)) {
        setProviderMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProviderMenuOpen(false);
      }
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [providerMenuOpen]);

  const handleAddPane = useCallback(() => {
    if (currentProjectPath && canAddPane()) {
      addPane(currentProjectPath, selectedProvider);
    }
  }, [currentProjectPath, selectedProvider, addPane, canAddPane]);

  const handleSplitPane = useCallback(() => {
    if (focusedPaneId && currentProjectPath && canAddPane()) {
      splitPane(focusedPaneId, currentProjectPath);
    }
  }, [focusedPaneId, currentProjectPath, splitPane, canAddPane]);

  const handleClosePane = useCallback(() => {
    if (focusedPaneId) {
      removePane(focusedPaneId);
    }
  }, [focusedPaneId, removePane]);

  const handleRenamePane = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (focusedPaneId) {
      updateSession(focusedPaneId, { name: e.target.value });
    }
  }, [focusedPaneId, updateSession]);

  const handleColorChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    if (focusedPaneId) {
      updateSession(focusedPaneId, { groupColor: e.target.value });
    }
  }, [focusedPaneId, updateSession]);

  const openTaskCount = useKanbanStore((state) => state.tasks.filter((task) => task.column !== 'done').length);
  const runningAgentCount = useSwarmStore((state) =>
    state.activeAgents.filter((agent) => ['running', 'waiting', 'review'].includes(agent.status)).length
  );
  const handleAddWorkspace = async () => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        // Always add a new instance, so the same folder can be opened multiple times.
        await addWorkspace(selectedPath);
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  // Right-clicking a workspace row opens a small menu near the cursor. Position
  // is clamped so the menu stays on-screen near the bottom edge.
  const handleWorkspaceContextMenu = (path: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const MENU_HEIGHT = 48;
    const y = Math.min(e.clientY, window.innerHeight - MENU_HEIGHT - 8);
    setWorkspaceMenu({ x: e.clientX, y, path });
  };

  const closeWorkspaceMenu = () => setWorkspaceMenu(null);

  const handleCloseWorkspace = (id: string) => {
    // Kill the workspace's terminals first so their PTY child processes don't outlive it.
    // (`closeWorkspace` only removes the workspace from the list; its async teardown's state
    // update lands after the workspace switch, which is correct — it then only touches the
    // closed workspace's panes, not the newly active one.)
    void useTerminalStore.getState().closeWorkspaceTerminals(id);
    closeWorkspace(id);
  };

  const handleRevealWorkspace = async () => {
    if (workspaceMenu) {
      try {
        // Empty filePath targets the workspace root folder itself.
        await invoke('reveal_in_file_explorer', { projectPath: workspaceMenu.path, filePath: '' });
      } catch (error) {
        console.error('Failed to open workspace in file explorer:', error);
      }
    }
    closeWorkspaceMenu();
  };

  useEffect(() => {
    if (!workspaceMenu) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWorkspaceMenu();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaceMenu]);

  return (
    <aside className="sidebar-area">
      <div className="sidebar-brand workspace-rail-brand">
        <div className="brand-mark" aria-hidden="true">
          <img src={bridgeMark} alt="" />
        </div>
        <div className="brand-copy">
          <strong>Saple Bridge</strong>
        </div>
      </div>

      <nav className="room-nav room-nav-primary" aria-label="Rooms">
        {primaryNavItems.map((item) => {
          const Icon = item.icon;
          const disabled = workspaceRooms.includes(item.id) && !currentProjectPath;
          const active = activeView === item.id;

          return (
            <button
              key={item.id}
              className={`room-nav-item accent-${item.accent} ${active ? 'active' : ''}`}
              onClick={() => !disabled && setActiveView(item.id)}
              disabled={disabled}
              title={disabled ? `Open a workspace to access ${item.label}` : item.label}
              aria-label={item.label}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {item.id === 'review' && openTaskCount > 0 && (
                <span className="badge review-badge">{openTaskCount}</span>
              )}
              {item.id === 'swarm' && runningAgentCount > 0 && (
                <span className="badge swarm-badge">{runningAgentCount}</span>
              )}
            </button>
          );
        })}
      </nav>

      <section className="recent-workspaces workspace-rail" aria-label="Workspaces">
          <div className="sidebar-section-title">
            <History size={12} />
            <span>Workspaces</span>
            <div className="workspace-rail-heading-actions">
              <button
                onClick={handleAddWorkspace}
                disabled={workspaceLoading}
                title="Add workspace"
                aria-label="Add workspace"
              >
                <Plus size={12} />
              </button>
              <button title="Workspace options" aria-label="Workspace options">
                <ChevronsUpDown size={12} />
              </button>
            </div>
          </div>
          <div className="recent-workspace-list">
            {openWorkspaces.map((workspace, index) => {
              const active = currentWorkspaceId === workspace.id;
              const circleColor = COLOR_PRESETS[index % COLOR_PRESETS.length].value;
              const circleStyle = active
                ? {
                    backgroundColor: circleColor,
                    boxShadow: `0 0 0 3px ${circleColor}33, 0 0 6px ${circleColor}`
                  }
                : {
                    backgroundColor: circleColor,
                    opacity: 0.5
                  };

              return (
                <div
                  key={workspace.id}
                  className={active ? 'workspace-rail-row active' : 'workspace-rail-row'}
                  onContextMenu={(e) => handleWorkspaceContextMenu(workspace.path, e)}
                >
                  <button
                      className={active ? 'recent-workspace active' : 'recent-workspace'}
                      onClick={() => {
                        if (!active) openWorkspaceInstance(workspace.id);
                        setActiveView('terminals');
                      }}
                      title={workspace.path}
                      disabled={workspaceLoading}
                    >
                    <span className="workspace-status" style={circleStyle} />
                    <span>{workspace.name}</span>
                  </button>
                  <button
                    className="workspace-rail-close"
                    onClick={() => handleCloseWorkspace(workspace.id)}
                    title="Close workspace"
                    aria-label={`Close ${workspace.name}`}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
            {openWorkspaces.length === 0 && (
              <div className="workspace-rail-empty">No workspace opened yet.</div>
            )}
          </div>
        </section>

      {workspaceMenu && (
        <>
          {/* Full-screen backdrop closes the menu on any outside interaction. */}
          <div
            className="workspace-context-backdrop"
            onClick={closeWorkspaceMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeWorkspaceMenu();
            }}
          />
          <div
            className="workspace-context-menu"
            style={{ top: workspaceMenu.y, left: workspaceMenu.x }}
            role="menu"
          >
            <button
              type="button"
              className="workspace-context-item"
              role="menuitem"
              onClick={handleRevealWorkspace}
            >
              <FolderOpen size={14} />
              <span>Open in File Explorer</span>
            </button>
          </div>
        </>
      )}
      <div className="sidebar-spacer" aria-hidden="true" />

      {activeView === 'terminals' && panes.length > 0 && (
        <div className="sidebar-terminal-controls">
          <div
            className="extracted-style-014 sidebar-section-title clickable-header"
            onClick={() => setControlsCollapsed(!controlsCollapsed)}
          >
             <TerminalIcon size={12} className="terminal-icon-glow" />
             <span>Terminal Controls</span>
             <span className="sidebar-pane-count">{panes.length}/{maxLimit}</span>
          </div>

          {!controlsCollapsed && (
            <div className="sidebar-control-group">
              <div className="sidebar-control-grid terminal-action-grid">
                {/* Dropdown Select Wrapper */}
                <div className="sidebar-select-wrapper" title="Terminal type for new panes" ref={providerPickerRef}>
                  <button
                    type="button"
                    className="terminal-provider-trigger"
                    onClick={() => setProviderMenuOpen((prev) => !prev)}
                    aria-haspopup="listbox"
                    aria-expanded={providerMenuOpen}
                    aria-label="Terminal type for new panes"
                  >
                    <Bot size={14} className="extracted-style-015" />
                    <span className="terminal-provider-label">
                      {AI_PROVIDERS.find((option) => option.value === selectedProvider)?.label ?? 'Claude'}
                    </span>
                    <ChevronsUpDown size={12} className="terminal-provider-chevron" />
                  </button>
                  {providerMenuOpen && (
                    <div className="terminal-provider-menu" role="listbox" aria-label="Terminal type for new panes">
                      {AI_PROVIDERS.map((option) => {
                        const active = option.value === selectedProvider;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            role="option"
                            aria-selected={active}
                            className={`terminal-provider-option ${active ? 'active' : ''}`}
                            onClick={() => {
                              setSelectedProvider(option.value);
                              setProviderMenuOpen(false);
                            }}
                          >
                            <span className="terminal-provider-option-label">{option.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* New Button */}
                <button
                  onClick={handleAddPane}
                  disabled={atMax}
                  className="sidebar-action-btn"
                  title={atMax ? `Pane limit reached (${maxLimit} max)` : 'Open new terminal pane'}
                >
                  <Plus size={14} />
                  <span>New</span>
                </button>

                {/* Split Button */}
                <button
                  onClick={handleSplitPane}
                  disabled={!focusedPaneId || atMax}
                  className="sidebar-action-btn"
                  title={atMax ? `Pane limit reached (${maxLimit} max)` : 'Split focused terminal pane'}
                >
                  <Split size={13} />
                  <span>Split</span>
                </button>

                {/* Close Button */}
                <button
                  onClick={handleClosePane}
                  disabled={!focusedPaneId}
                  className="sidebar-action-btn danger-button"
                  title="Close focused terminal pane"
                >
                  <Trash2 size={13} />
                  <span>Close</span>
                </button>
              </div>

              {/* Focused session controls */}
              {focusedSession && (
                <div className="sidebar-focused-controls">
                  <div className="sidebar-divider" />

                  <div className="sidebar-control-row terminal-detail-row">
                    {/* Rename Pane */}
                    <div className="sidebar-input-group">
                      <Edit3 size={13} className="extracted-style-016" />
                      <input
                        value={focusedSession.name}
                        onChange={handleRenamePane}
                        placeholder="Rename pane..."
                        className="terminal-rename-input"
                        title="Rename active terminal pane"
                      />
                    </div>

                    {/* Color Group */}
                    <div className="sidebar-input-group">
                      <Tag size={13} style={{ color: focusedSession.groupColor }} />
                      <select
                        value={focusedSession.groupColor}
                        onChange={handleColorChange}
                        className="terminal-color-select"
                        title="Change terminal color group"
                      >
                        {COLOR_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>
                            {preset.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* Utilities Row */}
                  <div className="sidebar-control-row utils-row">
                    {maximizedPaneId ? (
                      <button
                        onClick={() => toggleMaximizePane(maximizedPaneId)}
                        className="sidebar-action-btn"
                        title="Restore pane to grid"
                      >
                        <Minimize2 size={13} />
                        <span>Restore</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => focusedPaneId && toggleMaximizePane(focusedPaneId)}
                        className="sidebar-action-btn"
                        title="Maximize focused pane"
                      >
                        <Maximize2 size={13} />
                        <span>Maximize</span>
                      </button>
                    )}

                    {/* Terminal font — app-wide; sits to the right of Maximize */}
                    <div className="sidebar-input-group terminal-font-group">
                      <TerminalIcon size={13} className="extracted-style-017" />
                      <select
                        value={fontId}
                        onChange={(e) => setFontId(e.target.value)}
                        className="terminal-font-select"
                        title="Terminal font"
                        aria-label="Terminal font"
                      >
                        {TERMINAL_FONT_OPTIONS.map((option) => (
                          <option key={option.id} value={option.id}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <nav className="room-nav room-nav-secondary" aria-label="Workspace tools">
        {secondaryNavItems.map((item) => {
          const Icon = item.icon;
          const disabled = workspaceRooms.includes(item.id) && !currentProjectPath;
          const active = activeView === item.id;
          const navButton = (
            <button
              key={item.id}
              className={`room-nav-item accent-${item.accent} ${active ? 'active' : ''}`}
              onClick={() => !disabled && setActiveView(item.id)}
              disabled={disabled}
              title={disabled ? `Open a workspace to access ${item.label}` : item.label}
              aria-label={item.label}
            >
              <Icon size={18} />
              <span>{item.label}</span>
              {item.id === 'review' && openTaskCount > 0 && (
                <span className="badge review-badge">{openTaskCount}</span>
              )}
              {item.id === 'swarm' && runningAgentCount > 0 && (
                <span className="badge swarm-badge">{runningAgentCount}</span>
              )}
            </button>
          );

          if (item.id === 'settings') {
            return (
              <div key={item.id} className="settings-command-row">
                {navButton}
                <button
                  className="icon-button sidebar-command-button"
                  onClick={onOpenPalette}
                  title="Command palette (Ctrl+P)"
                  aria-label="Command palette"
                >
                  <Command size={17} />
                </button>
              </div>
            );
          }

          return navButton;
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-summary">
          <span>{panes.length} panes</span>
          <span>{runningAgentCount} agents</span>
          <span>{openTaskCount} open tasks</span>
        </div>
      </div>
    </aside>
  );
};
