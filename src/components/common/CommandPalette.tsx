import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Search, Terminal, ClipboardList, Network, Users,
  GitPullRequest, Settings, FolderOpen, ShieldCheck,
  HelpCircle, Play, ChevronRight, CornerDownLeft, ArrowLeft, Keyboard,
  MessageSquarePlus, Send, Bot, Monitor
} from 'lucide-react';
import { useProjectStore } from '../../stores/projectStore';
import { useTerminalStore, AiProvider } from '../../stores/terminalStore';
import { useKanbanStore, Task } from '../../stores/kanbanStore';
import { useSwarmStore } from '../../stores/swarmStore';
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
  // When true, open straight into the composer's target picker (its own global shortcut).
  initialCompose?: boolean;
}

type PaletteMode = 'commands' | 'rooms' | 'tasks' | 'compose-target' | 'compose-message';

// Where a composed message is sent. Picked in compose-target mode; acted on when the message is sent.
type ComposeTarget =
  | { kind: 'agent'; label: string; agentId: string }
  | { kind: 'all-agents'; label: string }
  | { kind: 'terminal'; label: string }
  | { kind: 'task'; label: string; task: Task }
  | { kind: 'new-swarm'; label: string }
  | { kind: 'memory'; label: string };

interface CommandItem {
  id: string;
  name: string;
  description: string;
  category: string;
  shortcut?: string;
  icon: React.ElementType;
  action: () => void;
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({ isOpen, onClose, initialCompose }) => {
  const { currentProjectPath, openWorkspace, setActiveView } = useProjectStore();
  const addPane = useTerminalStore((state) => state.addPane);
  const tasks = useKanbanStore((state) => state.tasks);
  const activeAgents = useSwarmStore((state) => state.activeAgents);
  const memoryNodes = useMemoryStore((state) => state.nodes);
  const success = (msg: string, desc?: string) => useNotificationStore.getState().success(msg, desc);
  const error = (msg: string, desc?: string) => useNotificationStore.getState().error(msg, desc);

  const [search, setSearch] = useState('');
  const [mode, setMode] = useState<PaletteMode>('commands');
  const [composeTarget, setComposeTarget] = useState<ComposeTarget | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Agents that can receive a mailbox message right now.
  const runningAgents = useMemo(
    () => activeAgents.filter((a) => a.status === 'running' || a.status === 'starting'),
    [activeAgents]
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen, onClose);

  // Focus input on mount
  useEffect(() => {
    if (isOpen) {
      setSearch('');
      setMode(initialCompose ? 'compose-target' : 'commands');
      setComposeTarget(null);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
      // Warm the memory graph so note titles are searchable even before the Memory view has
      // been visited (loadGraph short-circuits if already loaded for this project).
      if (currentProjectPath) {
        void useMemoryStore.getState().loadGraph(currentProjectPath);
      }
    }
  }, [isOpen, currentProjectPath, initialCompose]);

  // Handle global shortcuts & navigation
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (mode === 'compose-message') {
          // Step back to the target picker rather than all the way out, keeping the drafted target.
          setMode('compose-target');
          setSearch('');
          setSelectedIndex(0);
          e.preventDefault();
        } else if (mode !== 'commands') {
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

  // Guard shared by every launch path: existing pane cap must not be exceeded (acceptance: launch
  // actions obey existing pane limits). Returns true when there is room.
  const hasPaneRoom = () => {
    const term = useTerminalStore.getState();
    if (term.panes.length >= term.getMaxPaneLimit()) {
      error('Pane limit reached. Close a terminal before launching another agent.');
      return false;
    }
    return true;
  };

  const handleLaunchTask = async (task: Task, extraNote?: string) => {
    onClose();
    if (!currentProjectPath) return;

    const provider = task.agentConfig?.provider || 'codex';
    const isReady = await invoke<boolean>('has_api_key', { service: `saple_provider_${provider}_api_key` })
      .catch(() => false);

    if (!isReady) {
      error(`Provider "${provider}" is not authenticated. Configure it in Settings.`);
      return;
    }
    if (!hasPaneRoom()) return;

    try {
      const sessionId = createId('agent');
      const promptPath = `.saple/agents/prompts/${sessionId}.md`;
      const model = task.agentConfig?.model || 'default';
      const note = extraNote?.trim();
      const promptContent = note
        ? `${buildTaskAgentPrompt(task)}\n## Operator Note\n${note}\n`
        : buildTaskAgentPrompt(task);

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

  // Composer: launch a one-off agent in Command Room with the composed text as its prompt.
  const launchTerminalAgent = async (text: string) => {
    onClose();
    if (!currentProjectPath) {
      error('Open a workspace first.');
      return;
    }
    const cfg = useProjectStore.getState().workspaceConfig;
    const provider = (cfg?.defaultProvider || 'claude') as AiProvider;
    const isReady = await invoke<boolean>('has_api_key', { service: `saple_provider_${provider}_api_key` })
      .catch(() => false);
    if (!isReady) {
      error(`Provider "${provider}" is not authenticated. Configure it in Settings.`);
      return;
    }
    if (!hasPaneRoom()) return;

    try {
      const sessionId = createId('agent');
      const promptPath = `.saple/agents/prompts/${sessionId}.md`;
      const model = cfg?.defaultModelByProvider?.[provider] || 'default';
      await invoke('write_project_file', {
        projectPath: currentProjectPath,
        filePath: promptPath,
        content: `# Agent Mission\n\n${text}\n`,
      });
      const paneId = await addPane(currentProjectPath, provider, model, promptPath);
      await useTerminalStore.getState().updateSession(paneId, { name: `${provider.toUpperCase()} Agent` });
      setActiveView('terminals');
      success(`Launched a new ${provider} terminal agent.`);
    } catch (err) {
      error(`Failed to launch terminal agent: ${String(err)}`);
    }
  };

  // Composer: move from the target picker to the message step, keeping focus in the input.
  const pickTarget = (target: ComposeTarget) => {
    setComposeTarget(target);
    setMode('compose-message');
    setSearch('');
    setSelectedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  // Composer: act on the drafted target with the typed message.
  const sendCompose = async () => {
    const target = composeTarget;
    const text = search.trim();
    if (!target || !text) return;
    if (!currentProjectPath) {
      error('Open a workspace first.');
      return;
    }
    switch (target.kind) {
      case 'agent':
        onClose();
        try {
          await useSwarmStore.getState().postToMailbox(currentProjectPath, target.agentId, text);
          success(`Sent to ${target.label}'s mailbox.`);
        } catch (err) {
          error(`Failed to post message: ${String(err)}`);
        }
        break;
      case 'all-agents':
        onClose();
        try {
          const ids = runningAgents.map((a) => a.id);
          await Promise.all(ids.map((id) => useSwarmStore.getState().postToMailbox(currentProjectPath, id, text)));
          success(`Sent to ${ids.length} running agent${ids.length === 1 ? '' : 's'}.`);
        } catch (err) {
          error(`Failed to broadcast message: ${String(err)}`);
        }
        break;
      case 'terminal':
        await launchTerminalAgent(text);
        break;
      case 'task':
        await handleLaunchTask(target.task, text);
        break;
      case 'new-swarm':
        onClose();
        useSwarmStore.getState().setPendingWizardMission(text);
        setActiveView('swarm');
        success('Opening the swarm wizard with your mission.');
        break;
      case 'memory':
        onClose();
        try {
          const firstLine = text.split('\n')[0].slice(0, 60).trim();
          const title = firstLine || 'Untitled note';
          const id = title.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || createId('note');
          await useMemoryStore.getState().saveNote(currentProjectPath, id, title, 'general', [], [], text);
          success(`Saved memory note "${title}".`);
        } catch (err) {
          error(`Failed to save memory note: ${String(err)}`);
        }
        break;
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
        id: 'open_local_preview',
        name: 'Open Local Preview',
        description: 'Preview a loopback dev URL and attach it to a task, agent, or memory',
        category: 'Preview',
        shortcut: 'Ctrl+Shift+B',
        icon: Monitor,
        action: () => {
          onClose();
          window.dispatchEvent(new Event('open-local-preview'));
        },
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
          id: 'compose',
          name: 'Compose / Send to Agent...',
          description: 'Message a running agent or launch a task, terminal, swarm, or memory note',
          category: 'Compose',
          shortcut: 'Ctrl+Shift+K',
          icon: MessageSquarePlus,
          action: () => {
            setMode('compose-target');
            setSearch('');
            setSelectedIndex(0);
          },
        },
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

    // In compose-message mode the input holds the message, not a filter — the send panel is
    // rendered separately, so there is no list here.
    if (mode === 'compose-message') return [];

    if (mode === 'compose-target') {
      const targets: CommandItem[] = [];
      runningAgents.forEach((a) => {
        targets.push({
          id: `ct-agent-${a.id}`,
          name: a.name,
          description: `Append a message to this running agent's mailbox`,
          category: a.role.toUpperCase(),
          icon: Bot,
          action: () => pickTarget({ kind: 'agent', label: a.name, agentId: a.id }),
        });
      });
      if (runningAgents.length > 0) {
        targets.push({
          id: 'ct-all-agents',
          name: 'All running agents',
          description: `Broadcast to all ${runningAgents.length} running agent mailbox${runningAgents.length === 1 ? '' : 'es'}`,
          category: 'Broadcast',
          icon: Users,
          action: () => pickTarget({ kind: 'all-agents', label: 'all running agents' }),
        });
      }
      targets.push({
        id: 'ct-terminal',
        name: 'New terminal agent',
        description: 'Launch a one-off agent in Command Room with your message as its prompt',
        category: 'Launch',
        icon: Terminal,
        action: () => pickTarget({ kind: 'terminal', label: 'a new terminal agent' }),
      });
      tasks
        .filter((t) => t.column !== 'done' && !t.terminalId)
        .forEach((t) => {
          targets.push({
            id: `ct-task-${t.id}`,
            name: `Task: ${t.title}`,
            description: 'Launch this Kanban task, appending your message as an operator note',
            category: 'Kanban',
            icon: ClipboardList,
            action: () => pickTarget({ kind: 'task', label: t.title, task: t }),
          });
        });
      targets.push(
        {
          id: 'ct-new-swarm',
          name: 'New swarm',
          description: 'Open the swarm wizard with your message pre-filled as the mission',
          category: 'Swarm',
          icon: Network,
          action: () => pickTarget({ kind: 'new-swarm', label: 'a new swarm' }),
        },
        {
          id: 'ct-memory',
          name: 'Project memory',
          description: 'Save your message as a memory note',
          category: 'Memory',
          icon: Network,
          action: () => pickTarget({ kind: 'memory', label: 'project memory' }),
        }
      );
      return targets.filter(
        (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
      );
    }

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
  }, [mode, search, baseCommands, roomsList, tasks, runningAgents, memoryNodes, currentProjectPath, setActiveView, onClose]);

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
    // Compose-message mode: the input is the message field, Enter sends it.
    if (mode === 'compose-message') {
      if (e.key === 'Enter') {
        e.preventDefault();
        void sendCompose();
      }
      return;
    }
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
              onClick={() => {
                setMode(mode === 'compose-message' ? 'compose-target' : 'commands');
                setSearch('');
              }}
              title="Go back"
              aria-label="Go back"
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
              mode === 'compose-target' ? 'Choose where to send...' :
              mode === 'compose-message' ? `Message ${composeTarget?.label ?? 'target'}...` :
              'Type a command or search...'
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="palette-badge">
            {mode === 'compose-target' || mode === 'compose-message' ? 'COMPOSE' : mode.toUpperCase()}
          </div>
        </div>

        {mode === 'compose-message' ? (
          <div className="palette-compose">
            <div className="palette-compose-target">
              <span className="palette-compose-target-label">Sending to</span>
              <span className="palette-compose-target-chip">{composeTarget?.label}</span>
            </div>
            <button
              className="palette-item selected"
              role="option"
              aria-selected
              onClick={() => void sendCompose()}
              disabled={!search.trim()}
            >
              <div className="palette-item-main">
                <Send className="palette-item-icon" size={15} />
                <div className="palette-item-meta">
                  <span className="palette-item-name">Send</span>
                  <span className="palette-item-desc">
                    {search.trim() ? 'Press Enter to send' : 'Type a message above first'}
                  </span>
                </div>
              </div>
              <div className="palette-item-aside">
                <kbd className="palette-kbd">Enter</kbd>
              </div>
            </button>
          </div>
        ) : (
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
        )}

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
