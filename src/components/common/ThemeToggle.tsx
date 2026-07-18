import React, { useEffect, useRef, useState } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import { useThemeStore, resolveTheme, THEME_OPTIONS } from '../../stores/themeStore';

interface ThemeToggleProps {
  size?: number;
  className?: string;
}

/**
 * Toolbar button that opens a menu of every available theme. The trigger shows a
 * Sun/Moon reflecting the currently resolved theme; the menu marks the active mode.
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({ size = 17, className }) => {
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDark = resolveTheme(mode) === 'dark';

  // Close on any outside pointer press or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="theme-menu-anchor">
      <button
        className={`icon-button${className ? ` ${className}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        title="Change theme"
        aria-label="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {isDark ? <Sun size={size} /> : <Moon size={size} />}
      </button>

      {open && (
        <div className="theme-menu" role="menu">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              className="theme-menu-item"
              role="menuitemradio"
              aria-checked={mode === option.value}
              onClick={() => {
                setMode(option.value);
                setOpen(false);
              }}
            >
              <Check size={14} className="theme-menu-check" style={{ opacity: mode === option.value ? 1 : 0 }} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
