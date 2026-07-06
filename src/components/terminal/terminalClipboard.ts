// Shortcut letters match on event.key OR event.code, because each covers a case the
// other misses: `code` is derived from the hardware scan code, which is 0 for synthetic
// keystrokes (SendInput from voice/automation tools, giving code:"") but is layout
// independent; `key` follows the active keyboard layout (Ctrl+V on a Cyrillic layout
// reports key:"м" but code:"KeyV") yet is always correct for synthetic input.
export const matchesShortcutLetter = (
  event: Pick<KeyboardEvent, 'key' | 'code'>,
  letter: string,
  physicalCode: string,
) => event.key.toLowerCase() === letter || event.code === physicalCode;

export const isTerminalCopyShortcut = (
  event: Pick<
    KeyboardEvent,
    'type' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey' | 'key' | 'code'
  >,
) =>
  event.type === 'keydown' &&
  event.ctrlKey &&
  event.shiftKey &&
  !event.altKey &&
  !event.metaKey &&
  matchesShortcutLetter(event, 'c', 'KeyC');

interface TerminalSelection {
  hasSelection: () => boolean;
  getSelection: () => string;
  clearSelection: () => void;
}

export const copyTerminalSelection = (
  terminal: TerminalSelection,
  writeClipboard: (text: string) => void | Promise<void>,
  options: { clearSelection?: boolean } = {},
) => {
  if (!terminal.hasSelection()) return false;

  const selection = terminal.getSelection();
  if (!selection) return false;

  void writeClipboard(selection);
  if (options.clearSelection) {
    terminal.clearSelection();
  }
  return true;
};
