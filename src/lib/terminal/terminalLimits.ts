export const TERMINAL_SCROLLBACK_ROWS = 10_000;
// Retained per-pane output kept for mount-time replay (the path an error-boundary remount
// takes; ordinary workspace switches keep panes mounted and don't replay). Sized to roughly
// match what TERMINAL_SCROLLBACK_ROWS lets the user scroll to, so a remounted pane restores
// its visible history instead of only the last few hundred lines. ~500 KB/pane is ~8 MB
// across the 16-pane max — negligible for a desktop app.
export const TERMINAL_OUTPUT_BUFFER_CHARS = 500_000;

// Bounds for the user-configurable scrollback (Settings > Workspace) and font size
// (Ctrl+= / Ctrl+- on a focused pane). Kept here so the store and the settings UI clamp
// to the same range.
export const MIN_SCROLLBACK_ROWS = 1_000;
export const MAX_SCROLLBACK_ROWS = 100_000;

export const DEFAULT_TERMINAL_FONT_SIZE = 14;
export const MIN_TERMINAL_FONT_SIZE = 8;
export const MAX_TERMINAL_FONT_SIZE = 28;
