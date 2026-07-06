export const TERMINAL_SCROLLBACK_ROWS = 10_000;
export const TERMINAL_OUTPUT_BUFFER_CHARS = 50_000;

// Bounds for the user-configurable scrollback (Settings > Workspace) and font size
// (Ctrl+= / Ctrl+- on a focused pane). Kept here so the store and the settings UI clamp
// to the same range.
export const MIN_SCROLLBACK_ROWS = 1_000;
export const MAX_SCROLLBACK_ROWS = 100_000;

export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;
