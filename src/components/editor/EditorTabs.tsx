import React, { useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { useFileStore } from '../../stores/fileStore';
import { useProjectStore } from '../../stores/projectStore';

const basename = (path: string) => path.split('/').pop() || path;

export const EditorTabs: React.FC = () => {
  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const openFiles = useFileStore((state) => state.openFiles);
  const activeFile = useFileStore((state) => state.activeFile);
  const dirty = useFileStore((state) => state.dirty);
  const openFile = useFileStore((state) => state.openFile);
  const closeTab = useFileStore((state) => state.closeTab);
  const tablistRef = useRef<HTMLDivElement>(null);

  const selectTab = useCallback(
    (path: string) => {
      if (currentProjectPath) openFile(currentProjectPath, path);
    },
    [currentProjectPath, openFile],
  );

  // W3C tabs pattern: Arrow keys move between tabs (activating them), Home/End
  // jump to the ends. Only the active tab stays in the Tab order (roving tabIndex);
  // the per-tab Close buttons remain individually tabbable after the tab itself.
  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (index + 1) % openFiles.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + openFiles.length) % openFiles.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = openFiles.length - 1;
    if (next === null) return;

    e.preventDefault();
    selectTab(openFiles[next]);
    requestAnimationFrame(() => {
      const tabs = tablistRef.current?.querySelectorAll<HTMLElement>('[role="tab"]');
      tabs?.[next].focus();
    });
  };

  if (openFiles.length === 0) return null;

  return (
    <div className="editor-tabs" role="tablist" aria-label="Open files" ref={tablistRef}>
      {openFiles.map((path, index) => {
        const isActive = path === activeFile;
        return (
          <div key={path} className={`editor-tab ${isActive ? 'active' : ''}`} title={path}>
            <button
              type="button"
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className="editor-tab-label"
              onClick={() => selectTab(path)}
              onKeyDown={(e) => handleTabKeyDown(e, index)}
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
            </button>
            <button
              type="button"
              className="editor-tab-close"
              aria-label={`Close ${basename(path)}`}
              onClick={() => {
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
