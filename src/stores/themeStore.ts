import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeMode =
  | 'system'
  | 'light'
  | 'dark'
  | 'ember'
  | 'mocha'
  | 'nord'
  | 'dracula'
  | 'tokyonight'
  | 'solarized'
  | 'latte';
export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

/** Single source of truth for the selectable themes, used by the toolbar menu and settings. */
export const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'ember', label: 'Ember' },
  { value: 'mocha', label: 'Mocha' },
  { value: 'nord', label: 'Nord' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'tokyonight', label: 'Tokyo Night' },
  { value: 'solarized', label: 'Solarized Light' },
  { value: 'latte', label: 'Catppuccin Latte' },
];

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Resolve a theme mode to a concrete theme value, consulting the OS only for 'system'. */
export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  if (typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches) {
    return 'dark';
  }
  return 'light';
}

/** Write the resolved theme onto <html data-theme> so the CSS variables switch. */
function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolveTheme(mode));
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => {
        applyTheme(mode);
        set({ mode });
      },
    }),
    {
      name: 'saple-bridge-theme-store',
      onRehydrateStorage: () => (state) => {
        // Re-apply once the persisted choice is restored.
        applyTheme(state?.mode ?? 'system');
      },
    }
  )
);
