import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  Search, Terminal, ClipboardList, Network, Users, 
  GitPullRequest, Settings, FolderOpen, ShieldCheck,
  HelpCircle, Play, ChevronRight, CornerDownLeft, ArrowLeft, Keyboard
} from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore } from '../../stores/terminalStore';
import { useKanbanStore, Task } from '../../stores/kanbanStore';
import { useMemoryStore } from '../../stores/memoryStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useShortcutsHelpStore } from '../../stores/shortcutsHelpStore';
import { useFileStore } from '../../stores/fileStore';
import { invoke } from '@tauri-apps/api/core';
import { createId } from '../../lib/id';
import { useFocusTrap } from '../../lib/useFocusTrap';
import { buildTaskAgentPrompt } from '../../lib/taskAgentPrompt';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

type PaletteMode = 'commands' | 'rooms' | 'tasks';

interface CommandItem {
  id: string;
  name: string;
  description: string;
  category: string;
  shortcut?: string;
  icon: React.ElementType;
  action: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose }) => {
  const { currentProjectPath, openWorkspace, setActiveView } = useProjectStore();
  const addPane = useTerminalStore((state) => state.addPane);
  const tasks = useKanbanStore((state) => state.tasks);
  const memoryNodes = useMemoryStore((state) => state.nodes);
  const success = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const error = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<PaletteMode>('commands');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen, onClose);

  // Focus input on mount
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setMode('commands');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
      // Warm the memory graph so note titles are searchable even before the Memory view has
      // been visited (loadGraph short-circuits if already loaded for this project).
      if (currentProjectPath) {
        void useMemoryStore.getState().loadGraph(currentProjectPath);
      }
    }
  }, [isOpen, currentProjectPath]);

  // Handle global shortcuts & navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode !== 'commands') {
          setMode('commands');
          setSearch('');
          setSelectedIndex(0);
          e.preventDefault();
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, mode, onClose]);

  // Command handlers
  const handleOpenWorkspace = async () => {
    onClose();
    try {
      const folder = await invoke<string | null>('select_directory');
      if (folder) {
        await openWorkspace(folder);
        success(`Opened workspace at ${folder}`);
      }
    } catch (err) {
      error(`Failed to open workspace: ${String(err)}`);
    }
  };

  const handleNewTerminal = async () => {
    onClose();
    if (!currentProjectPath) {
      error('Cannot open terminal: Open a workspace first.');
      return;
    }
    try {
      await addPane(currentProjectPath);
      setActiveView('terminals');
      success('Created new command room terminal pane.');
    } catch (err) {
      error(`Failed to create terminal: ${String(err)}`);
    }
  };

  const handleInstallMcp = async () => {
    onClose();
    if (!currentProjectPath) {
      error('Cannot install MCP config: Open a workspace first.');
      return;
    }
    try {
      const res = await invoke<string>('install_mcp_config', { projectPath: currentProjectPath });
      success('MCP configuration installed successfully.', res);
    } catch (err) {
      error(`Failed to install MCP config: ${String(err)}`);
    }
  };

  const handleRunDiagnostics = () => {
    onClose();
    // Store-driven tab selection: ProjectSettings consumes pendingSettingsTab on mount, so this
    // works regardless of how long the lazy-loaded settings view takes to appear (the old
    // setTimeout+querySelector approach silently no-oped on slow loads).
    useProjectStore.getState().setPendingSettingsTab('diagnostics');
    setActiveView('settings');
  };

  const handleLaunchTask = async (task: Task) => {
    onClose();
    if (!currentProjectPath) return;

    const provider = task.agentConfig?.provider || 'codex';
    const isReady = await invoke<boolean>('has_api_key', { service: `saple_provider_${provider}_api_key` })
      .catch(() => false);

    if (!isReady) {
      error(`Provider "${provider}" is not authenticated. Configure it in Settings.`);
      return;
    }

    try {
      const sessionId = createId('agent');
      const promptPath = `.saple/agents/prompts/${sessionId}.md`;
      const model = task.agentConfig?.model || 'default';
      const promptContent = buildTaskAgentPrompt(task);

      await invoke('write_project_file', {
        projectPath: currentProjectPath,
        filePath: promptPath,
        content: promptContent,
      });

      const paneId = await addPane(currentProjectPath, provider, model, promptPath);
      
      await useTerminalStore.getState().updateSession(paneId, {
        name: `${provider.toUpperCase()} Agent: ${task.title}`,
      });

      setActiveView('terminals');
      success(`Launched task "${task.title}" using ${provider}`);
    } catch (err) {
      error(`Failed to launch task: ${String(err)}`);
    }
  };

  // Build commands list
  const baseCommands = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [
      {
        id: 'open_workspace',
        name: 'Open Workspace...',
        description: 'Choose a folder from disk to load into Saple Bridge',
        category: 'Project',
        shortcut: 'Ctrl+O',
        icon: FolderOpen,
        action: handleOpenWorkspace,
      },
      {
        id: 'keyboard_shortcuts',
        name: 'Keyboard Shortcuts',
        description: 'View all global and terminal keyboard shortcuts',
        category: 'Help',
        icon: Keyboard,
        action: () => {
          onClose();
          useShortcutsHelpStore.getState().open();
        },
      },
    ];

    if (currentProjectPath) {
      list.push(
        {
          id: 'switch_room',
          name: 'Switch Room...',
          description: 'Navigate to a different bridge workspace room',
          category: 'Navigation',
          icon: ChevronRight,
          action: () => {
            setMode('rooms');
            setSearch('');
            setSelectedIndex(0);
          },
        },
        {
          id: 'new_terminal',
          name: 'New Terminal Pane',
          description: 'Open a native shell command-line pane in Command Room',
          category: 'Terminal',
          shortcut: 'Ctrl+Shift+T',
          icon: Terminal,
          action: handleNewTerminal,
        },
        {
          id: 'launch_task',
          name: 'Launch Agent Task...',
          description: 'Start an AI agent execution for a workspace Kanban task',
          category: 'Kanban',
          icon: Play,
          action: () => {
            setMode('tasks');
            setSearch('');
            setSelectedIndex(0);
          },
        },
        {
          id: 'search_in_files',
          name: 'Search in Files',
          description: 'Full-text search across the workspace in the Files room',
          category: 'Files',
          icon: Search,
          action: () => {
            useFileStore.getState().requestSearch();
            setActiveView('editor');
            onClose();
          },
        },
        {
          id: 'install_mcp',
          name: 'Install Saple MCP Config',
          description: 'Register the memory graph server globally for IDE access',
          category: 'MCP',
          icon: Network,
          action: handleInstallMcp,
        },
        {
          id: 'run_diagnostics',
          name: 'Run System Diagnostics',
          description: 'Check OS environment, shells, provider CLIs, and Keychain',
          category: 'System',
          icon: ShieldCheck,
          action: handleRunDiagnostics,
        }
      );
    }

    return list;
  }, [currentProjectPath]);

  // List of rooms
  const roomsList = useMemo<CommandItem[]>(() => [
    { id: 'dashboard', name: 'Home / Dashboard', description: 'Recent workspaces and project summary', category: 'Rooms', icon: FolderOpen, action: () => { setActiveView('dashboard'); onClose(); } },
    { id: 'terminals', name: 'Open Command Room', description: 'Split terminal grid and agent logs', category: 'Rooms', icon: Terminal, action: () => { setActiveView('terminals'); onClose(); } },
    { id: 'kanban', name: 'Tasks Board', description: 'Manage task items and launch agents', category: 'Rooms', icon: ClipboardList, action: () => { setActiveView('kanban'); onClose(); } },
    { id: 'memory', name: 'Memory Graph', description: 'Explore project knowledge wiki and snap links', category: 'Rooms', icon: Network, action: () => { setActiveView('memory'); onClose(); } },
    { id: 'swarm', name: 'Swarm Room', description: 'Define team agent workflows and message boxes', category: 'Rooms', icon: Users, action: () => { setActiveView('swarm'); onClose(); } },
    { id: 'review', name: 'Review Room', description: 'Approve or reject completed agent changes', category: 'Rooms', icon: GitPullRequest, action: () => { setActiveView('review'); onClose(); } },
    { id: 'editor', name: 'Files', description: 'Workspace file browser and visual editor', category: 'Rooms', icon: ChevronRight, action: () => { setActiveView('editor'); onClose(); } },
    { id: 'settings', name: 'Settings Room', description: 'Setup API keys, models, and run checks', category: 'Rooms', icon: Settings, action: () => { setActiveView('settings'); onClose(); } },
  ], []);

  // Filtered items based on mode
  const filteredItems = useMemo(() => {
    const q = search.toLowerCase();
    
    if (mode === 'rooms') {
      return roomsList.filter(r => r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q));
    }
    
    if (mode === 'tasks') {
      const openTasks = tasks.filter(t => t.column !== 'done' && !t.terminalId);
      return openTasks
        .filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
        .map(t => ({
          id: t.id,
          name: t.title,
          description: t.description || 'No description',
          category: 'Open Tasks',
          icon: ClipboardList,
          action: () => handleLaunchTask(t),
        } as CommandItem));
    }

    const commandMatches = baseCommands.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.category.toLowerCase().includes(q)
    );

    // Global search: from 2 typed characters on, also surface matching Kanban tasks and
    // memory notes below the command matches, jumping to the owning view on selection.
    if (!currentProjectPath || q.trim().length < 2) return commandMatches;

    const taskMatches = tasks
      .filter(t => t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q))
      .slice(0, 5)
      .map(t => ({
        id: `search-task-${t.id}`,
        name: t.title,
        description: `Task in "${t.column}" — open the Tasks board`,
        category: 'Tasks',
        icon: ClipboardList,
        action: () => {
          setActiveView('kanban');
          onClose();
        },
      } as CommandItem));

    const noteMatches = memoryNodes
      .filter(n =>
        n.title.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q) ||
        n.tags.some(tag => tag.toLowerCase().includes(q))
      )
      .slice(0, 5)
      .map(n => ({
        id: `search-note-${n.id}`,
        name: n.title,
        description: `Memory note (${n.category}) — open in Memory`,
        category: 'Memory',
        icon: Network,
        action: () => {
          void useMemoryStore.getState().loadNote(currentProjectPath, n);
          setActiveView('memory');
          onClose();
        },
      } as CommandItem));

    return [...commandMatches, ...taskMatches, ...noteMatches];
  }, [mode, search, baseCommands, roomsList, tasks, memoryNodes, currentProjectPath, setActiveView, onClose]);

  // Keep selected index in bounds when items change
  useEffect(() => {
    setSelectedIndex(0);
  }, [filteredItems]);

  // List scroll helper
  const handleScrollToElement = (index: number) => {
    if (!listRef.current) return;
    const items = listRef.current.children;
    if (items[index]) {
      items[index].scrollIntoView({ block: 'nearest' });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      setSelectedIndex((prev) => {
        const next = prev + 1 >= filteredItems.length ? 0 : prev + 1;
        handleScrollToElement(next);
        return next;
      });
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setSelectedIndex((prev) => {
        const next = prev - 1 < 0 ? filteredItems.length - 1 : prev - 1;
        handleScrollToElement(next);
        return next;
      });
      e.preventDefault();
    } else if (e.key === 'Enter') {
      const selected = filteredItems[selectedIndex];
      if (selected) {
        selected.action();
      }
      e.preventDefault();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div 
        ref={dialogRef}
        className="palette-dialog" 
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        tabIndex={-1}
      >
        <div className="palette-search-wrapper">
          {mode !== 'commands' ? (
            <button 
              className="palette-back-btn" 
              onClick={() => { setMode('commands'); setSearch(''); }}
              title="Go back to main commands"
              aria-label="Go back to main commands"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <Search className="palette-search-icon" size={16} />
          )}
          <input
            ref={inputRef}
            type="text"
            className="palette-input"
            placeholder={
              mode === 'rooms' ? 'Select a room...' : 
              mode === 'tasks' ? 'Select a task to launch...' : 
              'Type a command or search...'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="palette-badge">
            {mode.toUpperCase()}
          </div>
        </div>

        <div className="palette-results" ref={listRef} role="listbox">
          {filteredItems.length === 0 ? (
            <div className="palette-empty">
              <HelpCircle size={20} className="palette-empty-icon" />
              <span>No results found matching your search.</span>
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`palette-item ${index === selectedIndex ? 'selected' : ''}`}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="palette-item-main">
                    <Icon className="palette-item-icon" size={15} />
                    <div className="palette-item-meta">
                      <span className="palette-item-name">{item.name}</span>
                      <span className="palette-item-desc">{item.description}</span>
                    </div>
                  </div>
                  <div className="palette-item-aside">
                    {item.shortcut ? (
                      <kbd className="palette-kbd">{item.shortcut}</kbd>
                    ) : (
                      <span className="palette-category">{item.category}</span>
                    )}
                    <CornerDownLeft size={12} className="palette-enter-icon" />
                  </div>
                </button>
              );
            })
          )}
        </div>
        
        <div className="palette-footer">
          <div className="palette-help-pill">
            <span>↑↓</span> Navigate
          </div>
          <div className="palette-help-pill">
            <span>Enter</span> Select
          </div>
          <div className="palette-help-pill">
            <span>Esc</span> Close
          </div>
        </div>
      </div>
    </div>
  );
};
