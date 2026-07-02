import { ResolvedTheme } from '../../stores/themeStore';

export const DARK_TERMINAL_THEME = {
  background: '#121417',
  foreground: '#F3F4F6',
  cursor: '#5D5FEF',
  selectionBackground: '#5D5FEF40',
  black: '#121417',
  red: '#EF4444',
  green: '#10B981',
  yellow: '#F59E0B',
  blue: '#3B82F6',
  magenta: '#A855F7',
  cyan: '#06B6D4',
  white: '#F3F4F6',
  brightBlack: '#6B7280',
  brightRed: '#F87171',
  brightGreen: '#34D399',
  brightYellow: '#FBBF24',
  brightBlue: '#60A5FA',
  brightMagenta: '#C084FC',
  brightCyan: '#22D3EE',
  brightWhite: '#F9FAFB',
} as const;

const LIGHT_TERMINAL_THEME = {
  background: '#F4F5F7',
  foreground: '#1A1D22',
  cursor: '#5D5FEF',
  selectionBackground: '#5D5FEF33',
  black: '#1A1D22',
  red: '#DC2626',
  green: '#059669',
  yellow: '#B45309',
  blue: '#2563EB',
  magenta: '#9333EA',
  cyan: '#0891B2',
  white: '#4B5563',
  brightBlack: '#6B7280',
  brightRed: '#EF4444',
  brightGreen: '#10B981',
  brightYellow: '#D97706',
  brightBlue: '#3B82F6',
  brightMagenta: '#A855F7',
  brightCyan: '#0E7490',
  brightWhite: '#1A1D22',
} as const;

// Mocha terminal — warm taupe background to match the Mocha app palette, with
// softened ANSI colors so output harmonizes with the brown surfaces.
const MOCHA_TERMINAL_THEME = {
  background: '#383430',
  foreground: '#ECE6DC',
  cursor: '#E8833A',
  selectionBackground: '#E8833A40',
  black: '#383430',
  red: '#E06C5B',
  green: '#8FB572',
  yellow: '#E8A857',
  blue: '#6FA8C7',
  magenta: '#C08AC0',
  cyan: '#6FC2BE',
  white: '#ECE6DC',
  brightBlack: '#8A8273',
  brightRed: '#EC8273',
  brightGreen: '#A6C98C',
  brightYellow: '#F2BD78',
  brightBlue: '#8FBFD9',
  brightMagenta: '#D2A4D2',
  brightCyan: '#8FD3CF',
  brightWhite: '#F6F1E8',
} as const;

// Nord terminal — arctic Polar Night background with the Frost + Aurora ANSI palette.
const NORD_TERMINAL_THEME = {
  background: '#2E3440',
  foreground: '#D8DEE9',
  cursor: '#88C0D0',
  selectionBackground: '#88C0D040',
  black: '#3B4252',
  red: '#BF616A',
  green: '#A3BE8C',
  yellow: '#EBCB8B',
  blue: '#81A1C1',
  magenta: '#B48EAD',
  cyan: '#88C0D0',
  white: '#E5E9F0',
  brightBlack: '#4C566A',
  brightRed: '#BF616A',
  brightGreen: '#A3BE8C',
  brightYellow: '#EBCB8B',
  brightBlue: '#81A1C1',
  brightMagenta: '#B48EAD',
  brightCyan: '#8FBCBB',
  brightWhite: '#ECEFF4',
} as const;

// Dracula terminal — the official vivid Dracula ANSI palette on its deep slate.
const DRACULA_TERMINAL_THEME = {
  background: '#282A36',
  foreground: '#F8F8F2',
  cursor: '#BD93F9',
  selectionBackground: '#BD93F940',
  black: '#21222C',
  red: '#FF5555',
  green: '#50FA7B',
  yellow: '#F1FA8C',
  blue: '#BD93F9',
  magenta: '#FF79C6',
  cyan: '#8BE9FD',
  white: '#F8F8F2',
  brightBlack: '#6272A4',
  brightRed: '#FF6E6E',
  brightGreen: '#69FF94',
  brightYellow: '#FFFFA5',
  brightBlue: '#D6ACFF',
  brightMagenta: '#FF92DF',
  brightCyan: '#A4FFFF',
  brightWhite: '#FFFFFF',
} as const;

// Tokyo Night terminal — deep indigo background with the Tokyo Night "night" ANSI palette.
const TOKYO_NIGHT_TERMINAL_THEME = {
  background: '#1A1B26',
  foreground: '#C0CAF5',
  cursor: '#7AA2F7',
  selectionBackground: '#7AA2F740',
  black: '#15161E',
  red: '#F7768E',
  green: '#9ECE6A',
  yellow: '#E0AF68',
  blue: '#7AA2F7',
  magenta: '#BB9AF7',
  cyan: '#7DCFFF',
  white: '#A9B1D6',
  brightBlack: '#414868',
  brightRed: '#F7768E',
  brightGreen: '#9ECE6A',
  brightYellow: '#E0AF68',
  brightBlue: '#7AA2F7',
  brightMagenta: '#BB9AF7',
  brightCyan: '#7DCFFF',
  brightWhite: '#C0CAF5',
} as const;

// Solarized Light terminal — Ethan Schoonover's cream base3 background with the
// official Solarized ANSI palette (dark glyphs on light surface).
const SOLARIZED_LIGHT_TERMINAL_THEME = {
  background: '#FDF6E3',
  foreground: '#657B83',
  cursor: '#586E75',
  selectionBackground: '#268BD226',
  black: '#073642',
  red: '#DC322F',
  green: '#859900',
  yellow: '#B58900',
  blue: '#268BD2',
  magenta: '#D33682',
  cyan: '#2AA198',
  white: '#EEE8D5',
  brightBlack: '#002B36',
  brightRed: '#CB4B16',
  brightGreen: '#586E75',
  brightYellow: '#657B83',
  brightBlue: '#839496',
  brightMagenta: '#6C71C4',
  brightCyan: '#93A1A1',
  brightWhite: '#FDF6E3',
} as const;

// Catppuccin Latte terminal — the soft pastel Latte light palette (dark glyphs on light).
const CATPPUCCIN_LATTE_TERMINAL_THEME = {
  background: '#EFF1F5',
  foreground: '#4C4F69',
  cursor: '#8839EF',
  selectionBackground: '#8839EF26',
  black: '#5C5F77',
  red: '#D20F39',
  green: '#40A02B',
  yellow: '#DF8E1D',
  blue: '#1E66F5',
  magenta: '#EA76CB',
  cyan: '#179299',
  white: '#ACB0BE',
  brightBlack: '#6C6F85',
  brightRed: '#D20F39',
  brightGreen: '#40A02B',
  brightYellow: '#DF8E1D',
  brightBlue: '#1E66F5',
  brightMagenta: '#EA76CB',
  brightCyan: '#179299',
  brightWhite: '#BCC0CC',
} as const;

// Structural shape of an xterm palette (the literal `as const` objects above are all
// assignable to this), so the lookup map below isn't pinned to one theme's literals.
type XtermTheme = { readonly [K in keyof typeof DARK_TERMINAL_THEME]: string };

// Every resolved app theme maps to one xterm palette. Ember has no bespoke terminal
// palette, so it reuses the dark one; all others have a matching palette above. The
// `background` is always overridden at read time with the live `--bg-terminal`.
const TERMINAL_THEMES: Record<ResolvedTheme, XtermTheme> = {
  light: LIGHT_TERMINAL_THEME,
  dark: DARK_TERMINAL_THEME,
  ember: DARK_TERMINAL_THEME,
  mocha: MOCHA_TERMINAL_THEME,
  nord: NORD_TERMINAL_THEME,
  dracula: DRACULA_TERMINAL_THEME,
  tokyonight: TOKYO_NIGHT_TERMINAL_THEME,
  solarized: SOLARIZED_LIGHT_TERMINAL_THEME,
  latte: CATPPUCCIN_LATTE_TERMINAL_THEME,
};

// The pane and its xterm container are painted with the `--bg-terminal` CSS variable.
// xterm only paints whole character rows, so any sub-row remainder shows the pane
// background underneath. Read that same variable and use it as the xterm `background`
// so the rendered surface and the pane are one seamless color in every theme (the
// hardcoded theme backgrounds otherwise diverge from --bg-terminal on dark/ember,
// leaving a darker band below the terminal content).
function terminalSurface(): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--bg-terminal')
    .trim();
  return value || DARK_TERMINAL_THEME.background;
}

// Resolve the xterm palette for a given app theme, overriding `background` with the live
// `--bg-terminal` so the rendered surface and the pane stay one seamless color.
export function terminalThemeFor(resolved: ResolvedTheme) {
  const base = TERMINAL_THEMES[resolved] ?? DARK_TERMINAL_THEME;
  return { ...base, background: terminalSurface() };
}

// Read the palette straight from the live <html data-theme> (used at terminal creation,
// before the React theme value is wired up via the effect in useXtermSession).
export function getTerminalTheme() {
  const resolved = document.documentElement.getAttribute('data-theme') as ResolvedTheme | null;
  return terminalThemeFor(resolved ?? 'dark');
}
