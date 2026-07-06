import React, { useRef } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface Shortcut {
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

// Single source of truth for the shortcuts advertised to the user. Kept in sync with the
// handlers in App.tsx and useXtermSession.ts.
const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    shortcuts: [
      { keys: ['Ctrl', 'P'], label: 'Toggle command palette' },
      { keys: ['Ctrl', 'Shift', 'P'], label: 'Open command palette' },
      { keys: ['Ctrl', '/'], label: 'Show keyboard shortcuts' },
      { keys: ['Ctrl', 'O'], label: 'Open workspace' },
      { keys: ['Alt', '1'], label: 'Switch to a room (Alt + 1–9)' },
    ],
  },
  {
    title: 'Terminals',
    shortcuts: [
      { keys: ['Ctrl', 'Shift', 'T'], label: 'New terminal pane' },
      { keys: ['Ctrl', 'Alt', '→'], label: 'Focus next pane' },
      { keys: ['Ctrl', 'Alt', '←'], label: 'Focus previous pane' },
      { keys: ['Ctrl', 'Shift', 'R'], label: 'Open review room' },
    ],
  },
  {
    title: 'Inside a terminal pane',
    shortcuts: [
      { keys: ['Ctrl', 'F'], label: 'Find in terminal' },
      { keys: ['Ctrl', 'C'], label: 'Copy selection (or interrupt when none)' },
      { keys: ['Ctrl', 'V'], label: 'Paste' },
      { keys: ['Ctrl', '='], label: 'Increase font size' },
      { keys: ['Ctrl', '-'], label: 'Decrease font size' },
      { keys: ['Ctrl', '0'], label: 'Reset font size' },
      { keys: ['Right-click'], label: 'Copy / Paste / Clear / Search menu' },
      { keys: ['Drag title'], label: 'Reorder panes' },
    ],
  },
];

// A read-only reference dialog for every keyboard shortcut in the app (Phase 3.2), opened
// from the command palette or with Ctrl+/.
export const KeyboardShortcutsDialog: React.FC<KeyboardShortcutsDialogProps> = ({ isOpen, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="shortcuts-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
      >
        <div className="shortcuts-header">
          <div className="shortcuts-title">
            <Keyboard size={18} />
            <span>Keyboard Shortcuts</span>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close keyboard shortcuts">
            <X size={16} />
          </button>
        </div>

        <div className="shortcuts-body">
          {SHORTCUT_GROUPS.map((group) => (
            <section key={group.title} className="shortcuts-group">
              <h3 className="shortcuts-group-title">{group.title}</h3>
              <ul className="shortcuts-list">
                {group.shortcuts.map((shortcut) => (
                  <li key={shortcut.label} className="shortcuts-row">
                    <span className="shortcuts-label">{shortcut.label}</span>
                    <span className="shortcuts-keys">
                      {shortcut.keys.map((key, index) => (
                        <React.Fragment key={key}>
                          {index > 0 && <span className="shortcuts-plus">+</span>}
                          <kbd className="shortcuts-kbd">{key}</kbd>
                        </React.Fragment>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};
