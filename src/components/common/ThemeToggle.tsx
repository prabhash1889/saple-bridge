import React from 'react';
import { Moon, Sun } from 'lucide-react';
import { useThemeStore, resolveTheme } from '../../stores/themeStore';

interface ThemeToggleProps {
  size?: number;
  className?: string;
}

/**
 * Icon button that flips between light and dark themes. Shows the icon for the
 * theme it will switch *to*, mirroring common toggle conventions.
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ size = 17, className }) => {
  const mode = useThemeStore((state) => state.mode);
  const toggle = useThemeStore((state) => state.toggle);
  const isDark = resolveTheme(mode) === 'dark';
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';

  return (
    <button
      className={`icon-button${className ? ` ${className}` : ''}`}
      onClick={toggle}
      title={label}
      aria-label={label}
    >
      {isDark ? <Sun size={size} /> : <Moon size={size} />}
    </button>
  );
};
