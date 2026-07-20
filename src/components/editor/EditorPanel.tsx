import React, { useState, useEffect } from 'react';
import { Files, Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { FileTree } from '../files/FileTree';
import { FileSearchPanel } from '../files/FileSearchPanel';
import { CodeViewer } from './CodeViewer';
import { EditorTabs } from './EditorTabs';
import { useFileStore } from '../../stores/fileStore';

export const EditorPanel: React.FC = () => {
  const [mode, setMode] = useState<'files' | 'search'>('files');
  const [collapsed, setCollapsed] = useState(false);
  const pendingSearchOpen = useFileStore((s) => s.pendingSearchOpen);
  const consumeSearchRequest = useFileStore((s) => s.consumeSearchRequest);

  // The command palette's "Search in Files" navigates here and flips us to Search.
  useEffect(() => {
    if (pendingSearchOpen) {
      setMode('search');
      setCollapsed(false);
      consumeSearchRequest();
    }
  }, [pendingSearchOpen, consumeSearchRequest]);

  return (
    <div className="editor-room-layout">
      {collapsed ? (
        <div className="editor-room-sidebar collapsed">
          <button
            className="editor-sidebar-collapse-btn"
            onClick={() => setCollapsed(false)}
            title="Show explorer"
            aria-label="Show explorer"
          >
            <PanelLeftOpen size={14} />
          </button>
        </div>
      ) : (
        <div className="editor-room-sidebar">
          <div className="editor-sidebar-switch" role="tablist" aria-label="Explorer mode">
            <button
              role="tab"
              aria-selected={mode === 'files'}
              className={mode === 'files' ? 'active' : ''}
              onClick={() => setMode('files')}
            >
              <Files size={13} />
              <span>Files</span>
            </button>
            <button
              role="tab"
              aria-selected={mode === 'search'}
              className={mode === 'search' ? 'active' : ''}
              onClick={() => setMode('search')}
            >
              <Search size={13} />
              <span>Search</span>
            </button>
            <button
              className="editor-sidebar-collapse-btn"
              onClick={() => setCollapsed(true)}
              title="Hide explorer"
              aria-label="Hide explorer"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          {mode === 'files' ? <FileTree /> : <FileSearchPanel />}
        </div>
      )}
      <div className="editor-room-main">
        <EditorTabs />
        <CodeViewer />
      </div>
    </div>
  );
};
