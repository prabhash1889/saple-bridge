import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  TERMINAL_SCROLLBACK_ROWS,
  MIN_SCROLLBACK_ROWS,
  MAX_SCROLLBACK_ROWS,
} from '../lib/terminalLimits';

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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

/** Resolve a font id to its CSS font-family stack, falling back to the default font. */
export function fontStackFor(id: string): string {
  return (TERMINAL_FONT_OPTIONS.find((option) => option.id === id) ?? TERMINAL_FONT_OPTIONS[0]).stack;
}

interface TerminalFontState {
  fontId: string;
  // App-wide terminal text size (px), adjusted with Ctrl+= / Ctrl+- / Ctrl+0 on a pane.
  fontSize: number;
  // App-wide scrollback rows, configurable in Settings > Workspace.
  scrollbackRows: number;
  setFontId: (fontId: string) => void;
  setFontSize: (fontSize: number) => void;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  setScrollbackRows: (rows: number) => void;
}

// The terminal font, size, and scrollback are single app-wide preferences (every pane
// renders the same), persisted to localStorage like the theme so they survive reloads.
export const useTerminalFontStore = create<TerminalFontState>()(
  persist(
    (set) => ({
      fontId: DEFAULT_TERMINAL_FONT_ID,
      fontSize: DEFAULT_TERMINAL_FONT_SIZE,
      scrollbackRows: TERMINAL_SCROLLBACK_ROWS,
      setFontId: (fontId) => set({ fontId }),
      setFontSize: (fontSize) =>
        set({ fontSize: clamp(Math.round(fontSize), MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE) }),
      increaseFontSize: () =>
        set((state) => ({ fontSize: clamp(state.fontSize + 1, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE) })),
      decreaseFontSize: () =>
        set((state) => ({ fontSize: clamp(state.fontSize - 1, MIN_TERMINAL_FONT_SIZE, MAX_TERMINAL_FONT_SIZE) })),
      resetFontSize: () => set({ fontSize: DEFAULT_TERMINAL_FONT_SIZE }),
      setScrollbackRows: (rows) =>
        set({ scrollbackRows: clamp(Math.round(rows), MIN_SCROLLBACK_ROWS, MAX_SCROLLBACK_ROWS) }),
    }),
    {
      name: 'saple-bridge-terminal-font-store',
    }
  )
);
