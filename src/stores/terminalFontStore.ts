import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// One selectable terminal typeface. `stack` is the full CSS font-family value handed to
// xterm — the chosen face first, then a graceful fallback chain so panes still render a
// monospace font when the preferred one isn't installed.
export interface TerminalFontOption {
  id: string;
  label: string;
  stack: string;
}

// Shared tail appended to every stack so any unavailable choice still lands on a sane
// monospace font on Windows (Cascadia/Consolas) or elsewhere.
const FALLBACK = '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace';

export const TERMINAL_FONT_OPTIONS: TerminalFontOption[] = [
  {
    id: 'firacode-nf-mono',
    label: 'FiraCode Mono',
    stack: `"FiraCode Nerd Font Mono", "FiraCode Nerd Font", "Fira Code", ${FALLBACK}`,
  },
  {
    id: 'jetbrainsmono-nf',
    label: 'JetBrains Mono',
    stack: `"JetBrainsMono Nerd Font", "JetBrains Mono", ${FALLBACK}`,
  },
  {
    id: 'caskaydiacove-nf',
    label: 'Caskaydia NF',
    stack: `"CaskaydiaCove Nerd Font", "Cascadia Code", "Cascadia Mono", ${FALLBACK}`,
  },
  {
    id: 'hack-nf-mono',
    label: 'Hack Mono',
    stack: `"Hack Nerd Font Mono", "Hack Nerd Font", Hack, ${FALLBACK}`,
  },
  {
    id: 'cascadia-mono',
    label: 'Cascadia Mono',
    stack: `"Cascadia Mono", "Cascadia Code", ${FALLBACK}`,
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    stack: `"Fira Code", ${FALLBACK}`,
  },
  {
    id: 'source-code-pro',
    label: 'Source Code',
    stack: `"Source Code Pro", ${FALLBACK}`,
  },
  {
    id: 'consolas',
    label: 'Consolas',
    stack: `Consolas, ${FALLBACK}`,
  },
  {
    id: 'system-mono',
    label: 'System Mono',
    stack: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  },
];

export const DEFAULT_TERMINAL_FONT_ID = 'firacode-nf-mono';

// Font-size bounds for the Ctrl+= / Ctrl+- / Ctrl+0 controls. 14 matches the value the
// terminal shipped with before the size control existed, so nothing changes by default.
export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 32;

// Scrollback bounds. The default matches the old hard-coded TERMINAL_SCROLLBACK_ROWS so
// existing users see no change; the cap keeps a runaway value from ballooning xterm memory.
export const DEFAULT_TERMINAL_SCROLLBACK = 10_000;
export const MIN_TERMINAL_SCROLLBACK = 1_000;
export const MAX_TERMINAL_SCROLLBACK = 100_000;

const clampFontSize = (size: number) =>
  Math.min(MAX_TERMINAL_FONT_SIZE, Math.max(MIN_TERMINAL_FONT_SIZE, Math.round(size)));

const clampScrollback = (rows: number) =>
  Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(rows)));

/** Resolve a font id to its CSS font-family stack, falling back to the default font. */
export function fontStackFor(id: string): string {
  return (TERMINAL_FONT_OPTIONS.find((option) => option.id === id) ?? TERMINAL_FONT_OPTIONS[0]).stack;
}

interface TerminalFontState {
  fontId: string;
  fontSize: number;
  scrollbackRows: number;
  setFontId: (fontId: string) => void;
  setFontSize: (size: number) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  setScrollbackRows: (rows: number) => void;
}

// The terminal font, size, and scrollback are single app-wide preferences (every pane renders
// the chosen face/size), persisted to localStorage like the theme so they survive reloads.
export const useTerminalFontStore = create<TerminalFontState>()(
  persist(
    (set) => ({
      fontId: DEFAULT_TERMINAL_FONT_ID,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      scrollbackRows: DEFAULT_TERMINAL_SCROLLBACK,
      setFontId: (fontId) => set({ fontId }),
      setFontSize: (size) => set({ fontSize: clampFontSize(size) }),
      increaseFontSize: () => set((state) => ({ fontSize: clampFontSize(state.fontSize + 1) })),
      decreaseFontSize: () => set((state) => ({ fontSize: clampFontSize(state.fontSize - 1) })),
      resetFontSize: () => set({ fontSize: DEFAULT_TERMINAL_FONT_SIZE }),
      setScrollbackRows: (rows) => set({ scrollbackRows: clampScrollback(rows) }),
    }),
    {
      name: 'saple-bridge-terminal-font-store',
    }
  )
);
