import React, { useEffect, useRef } from 'react';
import { Copy, ClipboardPaste, Eraser, Search } from 'lucide-react';

export interface TerminalContextMenuProps {
  x: number;
  y: number;
  canCopy: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onSearch: () => void;
  onClose: () => void;
}

// Right-click menu overlay for mouse-first users (Copy / Paste / Clear / Search). Purely
// additive: it layers over the pane and never touches the existing titlebar controls.
export const TerminalContextMenu: React.FC<TerminalContextMenuProps> = ({
  x,
  y,
  canCopy,
  onCopy,
  onPaste,
  onClear,
  onSearch,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on any outside pointer press or Escape.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  // Keep the menu inside the viewport when opened near the right/bottom edge.
  const clampedX = Math.min(x, window.innerWidth - 180);
  const clampedY = Math.min(y, window.innerHeight - 160);

  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="terminal-context-menu"
      style={{ left: clampedX, top: clampedY }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <button className="terminal-context-item" role="menuitem" onClick={run(onCopy)} disabled={!canCopy}>
        <Copy size={14} />
        <span>Copy</span>
      </button>
      <button className="terminal-context-item" role="menuitem" onClick={run(onPaste)}>
        <ClipboardPaste size={14} />
        <span>Paste</span>
      </button>
      <button className="terminal-context-item" role="menuitem" onClick={run(onSearch)}>
        <Search size={14} />
        <span>Search</span>
      </button>
      <div className="terminal-context-sep" />
      <button className="terminal-context-item" role="menuitem" onClick={run(onClear)}>
        <Eraser size={14} />
        <span>Clear</span>
      </button>
    </div>
  );
};
