import React, { useEffect } from 'react';
import { FolderOpen } from 'lucide-react';
import { useMemoryStore } from '../../stores/memoryStore';
import { useProjectStore } from '../../stores/projectStore';
import { MemoryList } from './MemoryList';
import { MemoryGraph } from './MemoryGraph';
import { MemoryEditor } from './MemoryEditor';
import { invoke } from '@tauri-apps/api/core';

export const MemoryWorkspace: React.FC = () => {
  const { currentProjectPath, openWorkspace, setActiveView } = useProjectStore();
  const { loadGraph, activeNote } = useMemoryStore();

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
    <div className="memory-workspace">
      {/* Sidebar note list browser */}
      <MemoryList />

      {/* Main viewport switcher: Graph view or Editor */}
      <div className="memory-viewport">
        {activeNote ? <MemoryEditor /> : <MemoryGraph />}
      </div>
    </div>
  );
};
