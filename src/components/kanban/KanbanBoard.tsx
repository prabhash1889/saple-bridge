import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, FolderOpen } from 'lucide-react';
import { Task, TaskColumn, useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { KanbanColumn } from './KanbanColumn';
import { TaskDialog } from './TaskDialog';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { invoke } from '@tauri-apps/api/core';

const COLUMNS: { id: TaskColumn; title: string }[] = [
  { id: 'backlog', title: 'Backlog' },
  { id: 'progress', title: 'In Progress' },
  { id: 'review', title: 'In Review' },
  { id: 'done', title: 'Completed' },
];

const FILTERS_KEY = 'saple.kanban.filters';

interface PersistedFilters {
  provider: string;
  role: string;
  priority: string;
  search: string;
}

const loadFilters = (): PersistedFilters => {
  const fallback: PersistedFilters = { provider: 'all', role: 'all', priority: 'all', search: '' };
  try {
    const raw = localStorage.getItem(FILTERS_KEY);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<PersistedFilters>) };
  } catch {
    return fallback;
  }
};

export const KanbanBoard: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const currentProjectName = useProjectStore((state) => state.currentProjectName);
  const openWorkspace = useProjectStore((state) => state.openWorkspace);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const tasks = useKanbanStore((state) => state.tasks);
  const loadTasks = useKanbanStore((state) => state.loadTasks);
  const loading = useKanbanStore((state) => state.loading);
  const error = useKanbanStore((state) => state.error);

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);

  // Detail Drawer States
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Filter States (persisted across reloads via localStorage)
  const [filterProvider, setFilterProvider] = useState(() => loadFilters().provider);
  const [filterRole, setFilterRole] = useState(() => loadFilters().role);
  const [filterPriority, setFilterPriority] = useState(() => loadFilters().priority);
  const [searchQuery, setSearchQuery] = useState(() => loadFilters().search);

  useEffect(() => {
    if (currentProjectPath) {
      loadTasks(currentProjectPath);
    }
  }, [currentProjectPath, loadTasks]);

  // Persist filter/search selections so they survive reloads.
  useEffect(() => {
    try {
      localStorage.setItem(
        FILTERS_KEY,
        JSON.stringify({
          provider: filterProvider,
          role: filterRole,
          priority: filterPriority,
          search: searchQuery,
        }),
      );
    } catch {
      // Ignore storage write failures (e.g. private mode / quota).
    }
  }, [filterProvider, filterRole, filterPriority, searchQuery]);

  const handleOpenProject = async () => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        await openWorkspace(selectedPath);
        setActiveView('kanban');
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleCreateTask = useCallback(() => {
    setTaskToEdit(null);
    setIsDialogOpen(true);
  }, []);

  const handleEditTask = useCallback((task: Task) => {
    setTaskToEdit(task);
    setIsDialogOpen(true);
  }, []);

  const handleViewTask = useCallback((task: Task) => {
    setSelectedTask(task);
    setIsDrawerOpen(true);
  }, []);

  // Perform task filtering
  const tasksByColumn = useMemo(() => {
    const grouped: Record<TaskColumn, Task[]> = {
      backlog: [],
      progress: [],
      review: [],
      done: [],
    };

    for (const task of tasks) {
      if (filterProvider !== 'all' && task.agentConfig?.provider !== filterProvider) {
        continue;
      }
      if (filterRole !== 'all' && task.agentConfig?.role !== filterRole) {
        continue;
      }
      if (filterPriority !== 'all' && task.priority !== filterPriority) {
        continue;
      }
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase().trim();
        const matches =
          task.title.toLowerCase().includes(query) ||
          task.description.toLowerCase().includes(query) ||
          task.labels.some(label => label.toLowerCase().includes(query));
        if (!matches) continue;
      }

      grouped[task.column].push(task);
    }

    return grouped;
  }, [filterPriority, filterProvider, filterRole, searchQuery, tasks]);


  if (!currentProjectPath) {
    return (
      <div style={emptyContainerStyle}>
        <div style={emptyCardStyle}>
          <FolderOpen size={40} className="kanban-empty-icon" />
          <h3>No Workspace Active</h3>
          <p className="kanban-empty-text">
            Open a workspace directory to load and manage tasks.
          </p>
          <button onClick={handleOpenProject} className="primary">
            Open Workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={boardContainerStyle}>
      {/* Board Header */}
      <div style={headerStyle}>
        <div>
          <h2 style={titleStyle}>Saple Board</h2>
          <p style={subtitleStyle}>Workspace: <strong>{currentProjectName}</strong></p>
        </div>
        <button onClick={handleCreateTask} className="primary" style={addBtnStyle}>
          <Plus size={16} />
          <span>Add Task</span>
        </button>
      </div>

      {/* Filter Toolbar */}
      <div style={filterToolbarStyle}>
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search tasks, labels..."
          style={searchInputStyle}
        />
        <div className="kanban-empty-actions">
          <select
            value={filterProvider}
            onChange={e => setFilterProvider(e.target.value)}
            style={selectStyle}
            title="Filter by Provider"
          >
            <option value="all">All Providers</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude</option>
            <option value="gemini">Gemini</option>
            <option value="pi">Pi</option>
            <option value="opencode">OpenCode</option>
            <option value="custom">Custom</option>
          </select>

          <select
            value={filterRole}
            onChange={e => setFilterRole(e.target.value)}
            style={selectStyle}
            title="Filter by Role"
          >
            <option value="all">All Roles</option>
            <option value="builder">Builder</option>
            <option value="scout">Scout</option>
            <option value="reviewer">Reviewer</option>
            <option value="coordinator">Coordinator</option>
          </select>

          <select
            value={filterPriority}
            onChange={e => setFilterPriority(e.target.value)}
            style={selectStyle}
            title="Filter by Priority"
          >
            <option value="all">All Priorities</option>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div style={errorBannerStyle}>
          <span>Error loading tasks: {error}</span>
        </div>
      )}

      {/* Board Columns Grid */}
      {loading ? (
        <div style={loadingStyle}>Loading task board state...</div>
      ) : (
        <div style={columnsContainerStyle}>
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.id}
              id={col.id}
              title={col.title}
              tasks={tasksByColumn[col.id]}
              onEditTask={handleEditTask}
              onViewTask={handleViewTask}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Task Dialog */}
      <TaskDialog 
        isOpen={isDialogOpen} 
        onClose={() => setIsDialogOpen(false)} 
        taskToEdit={taskToEdit}
      />

      {/* Task Details sliding side drawer */}
      <TaskDetailDrawer
        isOpen={isDrawerOpen}
        task={selectedTask}
        onClose={() => { setIsDrawerOpen(false); setSelectedTask(null); }}
        onEdit={handleEditTask}
      />
    </div>
  );
};

/* --- Inline CSS Styles --- */

const boardContainerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  padding: '24px',
  backgroundColor: 'var(--bg-app)',
  overflow: 'hidden',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '16px',
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: '20px',
  fontWeight: 700,
  color: 'var(--text-primary)',
  letterSpacing: '-0.02em',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-secondary)',
  marginTop: '2px',
};

const addBtnStyle: React.CSSProperties = {
  height: '32px',
  fontSize: '13px',
  padding: '6px 14px',
};

const filterToolbarStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '16px',
  marginBottom: '20px',
  flexWrap: 'wrap',
  flexShrink: 0,
};

const searchInputStyle: React.CSSProperties = {
  height: '32px',
  padding: '0 12px',
  fontSize: '13px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface-light)',
  color: 'var(--text-primary)',
  width: '100%',
  maxWidth: '260px',
  boxSizing: 'border-box',
};

const selectStyle: React.CSSProperties = {
  height: '32px',
  padding: '0 12px',
  fontSize: '13px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--border)',
  backgroundColor: 'var(--bg-surface-light)',
  color: 'var(--text-primary)',
  boxSizing: 'border-box',
};

const errorBannerStyle: React.CSSProperties = {
  backgroundColor: 'var(--color-danger-bg)',
  border: '1px solid var(--color-danger)',
  borderRadius: 'var(--radius-sm)',
  padding: '12px 16px',
  color: 'var(--color-danger)',
  fontSize: '13px',
  marginBottom: '16px',
  flexShrink: 0,
};

const loadingStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: '14px',
  color: 'var(--text-secondary)',
};

const columnsContainerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '16px',
  flex: 1,
  overflowX: 'auto',
  overflowY: 'hidden',
  height: '100%',
  alignItems: 'flex-start',
  paddingBottom: '8px',
};

const emptyContainerStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'var(--bg-app)',
};

const emptyCardStyle: React.CSSProperties = {
  backgroundColor: 'var(--bg-surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-lg)',
  padding: '32px 24px',
  width: '100%',
  maxWidth: '380px',
  textAlign: 'center',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  boxShadow: 'var(--shadow-md)',
};
