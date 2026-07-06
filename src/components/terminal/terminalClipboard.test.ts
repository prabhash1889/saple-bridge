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

// Settles the copy pipeline's promise chain (macrotask outlasts every queued microtask).
const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

  it('copies an active terminal selection without clearing it by default', async () => {
    const writeClipboard = vi.fn().mockResolvedValue(undefined);
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'selected output'),
      clearSelection: vi.fn(),
    };

    expect(copyTerminalSelection(terminal, writeClipboard)).toBe(true);

    await flushAsync();
    expect(writeClipboard).toHaveBeenCalledWith('selected output');
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });

  it('can clear selection after copying for plain Ctrl+C behavior', async () => {
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'interrupt-safe copy'),
      clearSelection: vi.fn(),
    };

    copyTerminalSelection(terminal, vi.fn().mockResolvedValue(undefined), {
      clearSelection: true,
    });

    await flushAsync();
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('clears the selection only after the clipboard write succeeds', async () => {
    let resolveWrite: () => void = () => {};
    const writeClipboard = vi.fn(
      () => new Promise<void>((resolve) => { resolveWrite = resolve; }),
    );
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'pending copy'),
      clearSelection: vi.fn(),
    };

    copyTerminalSelection(terminal, writeClipboard, { clearSelection: true });

    await flushAsync();
    expect(terminal.clearSelection).not.toHaveBeenCalled();

    resolveWrite();
    await flushAsync();
    expect(terminal.clearSelection).toHaveBeenCalledTimes(1);
  });

  it('keeps the selection and reports the error when the clipboard write fails', async () => {
    const error = new Error('clipboard busy');
    const writeClipboard = vi.fn().mockRejectedValue(error);
    const onCopyFailed = vi.fn();
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'lost copy'),
      clearSelection: vi.fn(),
    };

    expect(
      copyTerminalSelection(terminal, writeClipboard, { clearSelection: true, onCopyFailed }),
    ).toBe(true);

    await flushAsync();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(onCopyFailed).toHaveBeenCalledWith(error);
  });

  it('treats a synchronous writer throw as a copy failure', async () => {
    const error = new Error('sync throw');
    const onCopyFailed = vi.fn();
    const terminal = {
      hasSelection: vi.fn(() => true),
      getSelection: vi.fn(() => 'sync failure'),
      clearSelection: vi.fn(),
    };

    expect(
      copyTerminalSelection(
        terminal,
        () => {
          throw error;
        },
        { clearSelection: true, onCopyFailed },
      ),
    ).toBe(true);

    await flushAsync();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
    expect(onCopyFailed).toHaveBeenCalledWith(error);
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
