import { describe, expect, it, vi } from 'vitest';
import {
  copyTerminalSelection,
  isTerminalCopyShortcut,
  matchesShortcutLetter,
} from './terminalClipboard';

const keyEvent = (overrides: Partial<KeyboardEvent> = {}) => ({
  type: 'keydown',
  ctrlKey: true,
  shiftKey: true,
  altKey: false,
  metaKey: false,
  key: 'c',
  code: 'KeyC',
  ...overrides,
} as Pick<
  KeyboardEvent,
  'type' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key' | 'code'
>);

describe('terminalClipboard', () => {
  it('matches shortcut letters by key or physical code', () => {
    expect(matchesShortcutLetter(keyEvent({ key: 'C', code: '' }), 'c', 'KeyC')).toBe(true);
    expect(matchesShortcutLetter(keyEvent({ key: 'x', code: 'KeyC' }), 'c', 'KeyC')).toBe(true);
    expect(matchesShortcutLetter(keyEvent({ key: 'x', code: 'KeyX' }), 'c', 'KeyC')).toBe(false);
  });

  it('recognizes Ctrl+Shift+C as terminal copy', () => {
    expect(isTerminalCopyShortcut(keyEvent())).toBe(true);
    expect(isTerminalCopyShortcut(keyEvent({ shiftKey: false }))).toBe(false);
    expect(isTerminalCopyShortcut(keyEvent({ altKey: true }))).toBe(false);
    expect(isTerminalCopyShortcut(keyEvent({ key: 'x', code: 'KeyX' }))).toBe(false);
  });

  it('copies an active terminal selection without clearing it by default', () => {
    const writeClipboard = vi.fn();
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'selected output'),
      clearSelection: vi.fn(),
    };

    expect(copyTerminalSelection(terminal, writeClipboard)).toBe(true);
    expect(writeClipboard).toHaveBeenCalledWith('selected output');
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('can clear selection after copying for plain Ctrl+C behavior', () => {
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'interrupt-safe copy'),
      clearSelection: vi.fn(),
    };

    copyTerminalSelection(terminal, vi.fn(), { clearSelection: true });

    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('does not write to the clipboard when xterm has no selected text', () => {
    const writeClipboard = vi.fn();
    const terminal = {
      hasSelection: vi.fn(() => false),
      getSelection: vi.fn(() => ''),
      clearSelection: vi.fn(),
    };

    expect(copyTerminalSelection(terminal, writeClipboard)).toBe(false);
    expect(writeClipboard).not.toHaveBeenCalled();
  });
});
