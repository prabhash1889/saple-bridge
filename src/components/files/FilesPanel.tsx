import React, { useCallback, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useFileStore, MIN_PANEL_WIDTH } from '../../stores/fileStore';
import { EditorPanel } from '../editor/EditorPanel';

// Files docked in the terminals room, right side - mirrors BrowserPanel's shell (left-edge resizer,
// header with close). The body reuses the full Files room (tree + tabs + editor) via EditorPanel,
// sharing fileStore so a file opened here and in the room stay in sync.

const MAX_PANEL_FRACTION = 0.7;

export const FilesPanel: React.FC = () => {
  const panelWidth = useFileStore((s) => s.panelWidth);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const width = dragWidth ?? panelWidth;

  const handleResizerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const right = panel.getBoundingClientRect().right;
    const maxWidth = (panel.parentElement?.getBoundingClientRect().width ?? right) * MAX_PANEL_FRACTION;
    let w = panel.getBoundingClientRect().width;
    const onMove = (e: PointerEvent) => {
      w = Math.round(Math.min(Math.max(right - e.clientX, MIN_PANEL_WIDTH), maxWidth));
      setDragWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      useFileStore.getState().setPanelWidth(w);
      setDragWidth(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return (
    <div className="files-panel" ref={panelRef} style={{ width }}>
      <div
        className="browser-resizer"
        onPointerDown={handleResizerPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize files panel"
      />
      <div className="files-panel-header">
        <span className="files-panel-title">Files</span>
        <button
          className="browser-toolbar-btn"
          onClick={() => useFileStore.getState().closePanel()}
          title="Close files panel"
          aria-label="Close files panel"
        >
          <X size={15} />
        </button>
      </div>
      <div className="files-panel-body">
        <EditorPanel />
      </div>
    </div>
  );
};
