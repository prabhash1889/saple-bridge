import React, { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useProjectStore, ViewType } from '../../stores/projectStore';
import { ThemeToggle } from '../common/ThemeToggle';

const roomMeta: Record<ViewType, { title: string; context: string }> = {
  dashboard: { title: 'Home', context: 'Choose a workspace flow.' },
  amber: { title: 'Amber', context: 'Chat with an AI agent that can use your project tools.' },
  terminals: { title: 'Command Room', context: 'Arrange terminals and AI agents.' },
  kanban: { title: 'Tasks', context: 'Plan, launch, and track agent-ready work.' },
  memory: { title: 'Memory', context: 'Local markdown graph and MCP-ready project knowledge.' },
  swarm: { title: 'Swarm Room', context: 'Coordinate multi-agent missions and handoffs.' },
  review: { title: 'Review Room', context: 'Human gate for diffs, test output, notes, and decisions.' },
  editor: { title: 'Files', context: 'Inspect, read, edit workspace files, or open them in external editors.' },
  settings: { title: 'Settings', context: 'Workspace, providers, memory, and diagnostics.' },
};

export const TopBar: React.FC = () => {
  const {
    activeView,
    currentProjectPath,
    currentProjectName,
  } = useProjectStore();
  const meta = roomMeta[activeView];
  const [branch, setBranch] = useState<string | null>(null);

  useEffect(() => {
    setBranch(null);
    if (!currentProjectPath) return;
    invoke<string>('git_current_branch', { projectPath: currentProjectPath })
      .then(setBranch)
      .catch(() => setBranch(null));
  }, [currentProjectPath]);

  return (
    <header className={`topbar-area ${activeView === 'dashboard' || activeView === 'terminals' ? 'workspace-first' : ''}`}>
      <div className="topbar-workspace">
        <strong>{currentProjectName ?? 'No Workspace Open'}</strong>
        <span className="topbar-path-line" title={currentProjectPath ?? undefined}>
          {branch && <GitBranch size={11} className="branch-icon" />}
          {branch ? <span className="branch-name">{branch}</span> : null}
          {currentProjectPath ? (
            <span className="path-truncate">{currentProjectPath}</span>
          ) : (
            'Open a folder to start a Saple Bridge room'
          )}
        </span>
      </div>

      <div className="topbar-room">
        <strong>{meta.title}</strong>
        <span>{meta.context}</span>
      </div>

      <div className="topbar-actions">
        <ThemeToggle />
      </div>
    </header>
  );
};
