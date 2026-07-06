import React, { useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { useMemoryStore } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';
import { MemoryList } from './MemoryList';
import { MemoryGraph } from './MemoryGraph';
import { MemoryEditor } from './MemoryEditor';
import { invoke } from '@tauri-apps/api/core';
import { PANE_WIDTH_LIMITS, useWorkspacePaneLayoutStore } from '../../stores/workspacePaneLayoutStore';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(value)));

const KEYBOARD_RESIZE_STEP = 24;

export const MemoryWorkspace: React.FC = () => {
  const { currentProjectPath, openWorkspace, setActiveView } = useProjectStore();
  const { loadGraph, activeNote } = useMemoryStore();
  const layout = useWorkspacePaneLayoutStore((state) =>
    currentProjectPath ? state.getLayout(currentProjectPath) : state.getLayout('__default__')
  );
  const setPaneLayout = useWorkspacePaneLayoutStore((state) => state.setLayout);

  useEffect(() => {
    if (currentProjectPath) {
      loadGraph(currentProjectPath);
    }
  }, [currentProjectPath, loadGraph]);

  const handleOpenProject = async () => {
    try {
      const selectedPath = await invoke<string | null>('select_directory');
      if (selectedPath) {
        await openWorkspace(selectedPath);
        setActiveView('memory');
      }
    } catch (error) {
      console.error('Failed to select directory:', error);
    }
  };

  const handleListResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = layout.memoryListWidth;
    const handleMouseMove = (moveEvent: MouseEvent) => {
      setPaneLayout(currentProjectPath, {
        memoryListWidth: clamp(
          startWidth + moveEvent.clientX - startX,
          PANE_WIDTH_LIMITS.memoryList.min,
          PANE_WIDTH_LIMITS.memoryList.max,
        ),
      });
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleListResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!currentProjectPath) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    setPaneLayout(currentProjectPath, {
      memoryListWidth: clamp(
        layout.memoryListWidth + direction * KEYBOARD_RESIZE_STEP,
        PANE_WIDTH_LIMITS.memoryList.min,
        PANE_WIDTH_LIMITS.memoryList.max,
      ),
    });
  };

  if (!currentProjectPath) {
    return (
      <div className="memory-empty-state">
        <div className="memory-empty-card">
          <FolderOpen size={40} className="extracted-style-025" />
          <h3>No Workspace Active</h3>
          <p>
            Open a workspace directory to load and view compounding memory.
          </p>
          <button onClick={handleOpenProject} className="primary">
            Open Workspace
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="memory-workspace resizable-memory-layout"
      style={{ gridTemplateColumns: `${layout.memoryListWidth}px 6px minmax(0, 1fr)` }}
    >
      {/* Sidebar note list browser */}
      <MemoryList />

      <div
        className="pane-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize memory list"
        aria-valuemin={PANE_WIDTH_LIMITS.memoryList.min}
        aria-valuemax={PANE_WIDTH_LIMITS.memoryList.max}
        aria-valuenow={layout.memoryListWidth}
        tabIndex={0}
        onMouseDown={handleListResizeStart}
        onKeyDown={handleListResizeKeyDown}
      />

      {/* Main viewport switcher: Graph view or Editor */}
      <div className="memory-viewport">
        {activeNote ? <MemoryEditor /> : <MemoryGraph />}
      </div>
    </div>
  );
};
