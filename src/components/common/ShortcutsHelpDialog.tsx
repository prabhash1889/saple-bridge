import React, { useRef } from 'react';
import { Keyboard, X } from 'lucide-react';
import { useShortcutsHelpStore } from '../../stores/shortcutsHelpStore';
import { useFocusTrap } from '../../lib/useFocusTrap';

interface ShortcutGroup {
  title: string;
  items: { keys: string[]; label: string }[];
}

// Documentation only — mirrors the bindings already wired in App.tsx and useXtermSession.
// Update this list when those handlers change; it registers no shortcuts of its own.
const GROUPS: ShortcutGroup[] = [
  {
    title: 'Global',
    items: [
      { keys: ['Ctrl', 'P'], label: 'Toggle command palette' },
      { keys: ['Ctrl', 'Shift', 'P'], label: 'Open command palette' },
      { keys: ['Ctrl', 'O'], label: 'Open workspace' },
      { keys: ['Alt', '1-9'], label: 'Switch room' },
      { keys: ['Ctrl', 'Shift', 'R'], label: 'Open Review room' },
    ],
  },
  {
    title: 'Terminals',
    items: [
      { keys: ['Ctrl', 'Shift', 'T'], label: 'New terminal pane' },
      { keys: ['Ctrl', 'Alt', '→'], label: 'Focus next pane' },
      { keys: ['Ctrl', 'Shift', 'Tab'], label: 'Focus next pane' },
    ],
  },
  {
    title: 'Inside a pane',
    items: [
      { keys: ['Ctrl', 'F'], label: 'Find in terminal' },
      { keys: ['Ctrl', 'C'], label: 'Copy selection (else interrupt)' },
      { keys: ['Ctrl', 'Shift', 'C'], label: 'Copy selection' },
      { keys: ['Ctrl', 'V'], label: 'Paste' },
      { keys: ['Ctrl', '='], label: 'Increase font size' },
      { keys: ['Ctrl', '-'], label: 'Decrease font size' },
      { keys: ['Ctrl', '0'], label: 'Reset font size' },
      { keys: ['Right-click'], label: 'Copy / Paste / Clear / Search menu' },
    ],
  },
];

export const ShortcutsHelpDialog: React.FC = () => {
  const isOpen = useShortcutsHelpStore((state) => state.isOpen);
  const close = useShortcutsHelpStore((state) => state.close);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen, close);

  if (!isOpen) return null;

  return (
    <div className="palette-overlay" onClick={close}>
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
            <Keyboard size={16} />
            <span>Keyboard Shortcuts</span>
          </div>
          <button className="terminal-pane-title-button" onClick={close} title="Close" aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="shortcuts-body">
          {GROUPS.map((group) => (
            <div key={group.title} className="shortcuts-group">
              <div className="shortcuts-group-title">{group.title}</div>
              {group.items.map((item) => (
                <div key={item.label} className="shortcuts-row">
                  <span className="shortcuts-label">{item.label}</span>
                  <span className="shortcuts-keys">
                    {item.keys.map((k) => (
                      <kbd key={k} className="palette-kbd">{k}</kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
