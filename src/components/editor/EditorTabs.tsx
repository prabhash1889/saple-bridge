import React from 'react';
import { X } from 'lucide-react';
import { useFileStore } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';

const basename = (path: string) => path.split('/').pop() || path;

export const EditorTabs: React.FC = () => {
  const { currentProjectPath } = useProjectStore();
  const { openFiles, activeFile, dirty, openFile, closeTab } = useFileStore();

  if (openFiles.length === 0) return null;

  return (
    <div className="editor-tabs" role="tablist" aria-label="Open files">
      {openFiles.map((path) => {
        const isActive = path === activeFile;
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            className={`editor-tab ${isActive ? 'active' : ''}`}
            title={path}
            onClick={() => currentProjectPath && openFile(currentProjectPath, path)}
            // Middle-click closes the tab.
            onMouseDown={(e) => {
              if (e.button === 1 && currentProjectPath) {
                e.preventDefault();
                closeTab(currentProjectPath, path);
              }
            }}
          >
            <span className="editor-tab-name">{basename(path)}</span>
            {isActive && dirty ? (
              <span className="editor-tab-dirty" aria-label="Unsaved changes" />
            ) : null}
            <button
              className="editor-tab-close"
              aria-label={`Close ${basename(path)}`}
              onClick={(e) => {
                e.stopPropagation();
                if (currentProjectPath) closeTab(currentProjectPath, path);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
