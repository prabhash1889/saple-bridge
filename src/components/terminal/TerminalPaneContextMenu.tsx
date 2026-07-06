import React, { useEffect, useRef, useState } from 'react';
import { ClipboardPaste, Copy, Eraser, FileDown, Search } from 'lucide-react';

export interface TerminalContextMenuState {
  x: number;
  y: number;
}

interface TerminalPaneContextMenuProps {
  position: TerminalContextMenuState;
  hasSelection: boolean;
  onCopy: () => void;
  onCopyAll: () => void;
  onPaste: () => void;
  onClear: () => void;
  onSearch: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 190;
const MENU_MAX_HEIGHT = 230;

// Right-click menu for terminal panes (Phase 3.3): Copy / Copy all / Paste / Clear / Search,
// so mouse-first users aren't stranded without the keyboard shortcuts. Positioned at the
// cursor and clamped to stay on screen; closes on outside click, Escape, or item selection.
export const TerminalPaneContextMenu: React.FC<TerminalPaneContextMenuProps> = ({
  position,
  hasSelection,
  onCopy,
  onCopyAll,
  onPaste,
  onClear,
  onSearch,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  // Start off-screen visibility-wise until we measure and clamp, to avoid a flash at the edge.
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: position.y, left: position.x });

  useEffect(() => {
    const left = Math.min(position.x, window.innerWidth - MENU_WIDTH - 8);
    const top = Math.min(position.y, window.innerHeight - MENU_MAX_HEIGHT - 8);
    setCoords({ top: Math.max(8, top), left: Math.max(8, left) });
  }, [position.x, position.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <>
      <div
        className="terminal-context-backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div
        ref={menuRef}
        className="terminal-context-menu"
        style={{ top: coords.top, left: coords.left }}
        role="menu"
      >
        <button type="button" className="terminal-context-item" role="menuitem" onClick={run(onCopy)} disabled={!hasSelection}>
          <Copy size={14} />
          <span>Copy</span>
        </button>
        <button type="button" className="terminal-context-item" role="menuitem" onClick={run(onCopyAll)}>
          <FileDown size={14} />
          <span>Copy all output</span>
        </button>
        <button type="button" className="terminal-context-item" role="menuitem" onClick={run(onPaste)}>
          <ClipboardPaste size={14} />
          <span>Paste</span>
        </button>
        <div className="terminal-context-divider" />
        <button type="button" className="terminal-context-item" role="menuitem" onClick={run(onSearch)}>
          <Search size={14} />
          <span>Search</span>
        </button>
        <button type="button" className="terminal-context-item" role="menuitem" onClick={run(onClear)}>
          <Eraser size={14} />
          <span>Clear</span>
        </button>
      </div>
    </>
  );
};
