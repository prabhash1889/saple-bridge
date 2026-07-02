import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Maximize2,
  Minimize2,
  Search,
  X,
  XCircle,
} from 'lucide-react';
import { useTerminalStore } from '../../stores/terminalStore';
import { useKanbanStore } from '../../stores/kanbanStore';
import { useProjectStore } from '../../stores/projectStore';
import { useReviewStore } from '../../stores/reviewStore';
import { useAgentSessionStore } from '../../stores/agentSessionStore';
import { TERMINAL_SCROLLBACK_ROWS } from '../../lib/terminalLimits';
import { useThemeStore, resolveTheme, ResolvedTheme } from '../../stores/themeStore';
import { useTerminalFontStore, fontStackFor } from '../../stores/terminalFontStore';
import '@xterm/xterm/css/xterm.css';

const DARK_TERMINAL_THEME = {
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
function terminalThemeFor(resolved: ResolvedTheme) {
  const base = TERMINAL_THEMES[resolved] ?? DARK_TERMINAL_THEME;
  return { ...base, background: terminalSurface() };
}

// Read the palette straight from the live <html data-theme> (used at terminal creation,
// before the React theme value is wired up via the effect below).
function getTerminalTheme() {
  const resolved = document.documentElement.getAttribute('data-theme') as ResolvedTheme | null;
  return terminalThemeFor(resolved ?? 'dark');
}

// Browsers / WebView2 cap simultaneous WebGL contexts (~16 per process). Each xterm
// WebGL renderer holds one context, so with many panes the cap is exceeded and the
// browser forcibly loses the oldest contexts, thrashing the GPU compositor. Cap the
// number of WebGL-accelerated panes; panes beyond the cap use the DOM renderer.
const MAX_WEBGL_CONTEXTS = 8;
let activeWebglContexts = 0;

// --- TEMP WebGL artifact diagnostics -------------------------------------------------
// Instrumentation to correlate the intermittent terminal render artifacts with WebGL
// context churn (acquire / release / evict / context-loss / DOM fallback). When you see
// an artifact, note the time and check the console: a `context-loss` or `evict` event
// immediately before it confirms the GPU-context juggling is the cause. Remove this block
// (and the webglDiag() calls below) once diagnosed.
const WEBGL_DIAG = true;
// Decisive A/B test: force every pane onto xterm's DOM renderer (skip WebGL entirely).
// Toggle live from the DevTools console WITHOUT a rebuild, then reload the window:
//   localStorage.setItem('saple-disable-webgl', '1')  // DOM renderer everywhere
//   localStorage.removeItem('saple-disable-webgl')     // back to WebGL
// If the artifacts disappear with WebGL disabled, the GPU-context juggling is the cause.
const isWebglDisabled = () => {
  try {
    return localStorage.getItem('saple-disable-webgl') === '1';
  } catch {
    return false;
  }
};
const webglDiag = (event: string, sessionId: string, extra?: Record<string, unknown>) => {
  if (!WEBGL_DIAG) return;
  // performance.now() is monotonic and avoids the Date.now() restrictions elsewhere.
  const t = Math.round(performance.now());
  // eslint-disable-next-line no-console
  console.log(
    `[webgl-diag +${t}ms] ${event} pane=${sessionId} active=${activeWebglContexts}/${MAX_WEBGL_CONTEXTS} holders=${webglHolders.size}`,
    extra ?? '',
  );
};
// -------------------------------------------------------------------------------------
// Panes that currently hold a WebGL context, mapped to their `unloadWebgl` release fn. When the
// context budget is spent, a newly-focused pane reclaims a context from a non-focused holder via
// this registry, so the pane the user is actually looking at always gets the GPU renderer even in
// rooms with more than MAX_WEBGL_CONTEXTS panes. Eviction frees a slot before a new context is
// acquired, so the hard cap is never exceeded.
const webglHolders = new Map<string, () => void>();

// On Windows the PTY backend is ConPTY (pty.rs spawns powershell.exe). ConPTY repaints on
// resize and, when rows grow, pushes the previous rows into the scrollback rather than
// leaving the viewport content in place. xterm only matches that model when told it's
// talking to a Windows pty — without it, growing the terminal (e.g. maximizing the window)
// REPLACES the existing rows and the shell banner/history is lost. Detect Windows from the
// WebView user agent (no extra deps) and pass it to the Terminal below.
const IS_WINDOWS_PTY = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

const isTerminalCopyShortcut = (event: KeyboardEvent) =>
  event.type === 'keydown' &&
  event.ctrlKey &&
  event.shiftKey &&
  !event.altKey &&
  event.code === 'KeyC';

const copyTextToClipboard = async (text: string) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (err) {
    console.warn('Navigator clipboard copy failed, falling back to execCommand:', err);
  }

  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement('textarea');

  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('document.execCommand("copy") returned false');
    }
  } catch (err) {
    console.error('Failed to copy terminal selection:', err);
  } finally {
    document.body.removeChild(textarea);
    activeElement?.focus();
  }
};

// Inert zeroed dimensions used while the terminal has no attached renderer (see
// guardRenderServiceDimensions). Shape mirrors xterm's IRenderDimensions so any consumer
// (Viewport._sync reads css.canvas.height / css.cell.height) gets harmless zeros instead
// of dereferencing a missing renderer.
const EMPTY_RENDER_DIMENSIONS = {
  css: { canvas: { width: 0, height: 0 }, cell: { width: 0, height: 0 } },
  device: {
    canvas: { width: 0, height: 0 },
    cell: { width: 0, height: 0 },
    char: { width: 0, height: 0, left: 0, top: 0 },
  },
};

// Root-cause fix for the intermittent terminal render artifacts (blank bands / dropped rows).
//
// xterm v6's RenderService.dimensions getter is the one renderer accessor that uses a
// non-null assertion (`this._renderer.value!.dimensions`) instead of guarding like every
// other method in that class. Viewport._sync() — queued on every scroll via an animation-
// frame refresh callback — reads that getter after only checking the *service* exists, not
// that a *renderer* is attached. When the queued _sync fires during a renderer teardown/swap
// (pane dispose, focus/visibility change, WebGL load/unload), `_renderer.value` is undefined
// and the getter throws. The throw propagates out of RenderDebouncer._innerRefresh, aborting
// the remaining refresh callbacks for that frame — so the actual row painting never runs and
// the viewport is left with unpainted (blank) bands until the next successful frame.
//
// We can't change xterm's bundled source, so we harden the getter on our own terminal
// instance: wrap it so a missing renderer yields inert zeroed dimensions instead of throwing.
// Uses only `_core._renderService`, the same internal contract the official WebGL addon relies
// on, and degrades to a no-op if xterm ever changes that shape.
const guardRenderServiceDimensions = (terminal: Terminal) => {
  try {
    const renderService = (terminal as unknown as {
      _core?: { _renderService?: object };
    })._core?._renderService;
    if (!renderService) return;

    const proto = Object.getPrototypeOf(renderService);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'dimensions');
    const originalGet = descriptor?.get;
    if (!originalGet) return;

    Object.defineProperty(renderService, 'dimensions', {
      configurable: true,
      get() {
        try {
          return originalGet.call(this);
        } catch {
          // No renderer attached (mid teardown/swap) — hand back inert dimensions so the
          // in-flight refresh callback completes instead of throwing and aborting the paint.
          return EMPTY_RENDER_DIMENSIONS;
        }
      },
    });
  } catch {
    // Internal shape changed — leave xterm untouched (we simply lose the hardening).
  }
};

interface TerminalScrollSnapshot {
  viewportY: number;
  wasAtBottom: boolean;
}

const captureTerminalScroll = (terminal: Terminal): TerminalScrollSnapshot => {
  const buffer = terminal.buffer.active;

  return {
    viewportY: buffer.viewportY,
    wasAtBottom: buffer.baseY - buffer.viewportY <= 1,
  };
};

const restoreTerminalScroll = (terminal: Terminal, snapshot: TerminalScrollSnapshot) => {
  if (snapshot.wasAtBottom) {
    terminal.scrollToBottom();
    return;
  }

  terminal.scrollToLine(Math.min(snapshot.viewportY, terminal.buffer.active.baseY));
};

// Re-sync xterm's scroll viewport after the pane goes display:none -> visible (workspace or
// view switch). In xterm v6 wheel scrollability is governed by Viewport._sync(), which only
// runs on buffer scroll/resize/activate events — terminal.refresh() repaints cells but does
// NOT re-sync the viewport, so the wheel stays dead until the next PTY write (the "press a
// key to unfreeze" symptom). A net-zero scroll nudge fires onScroll -> _sync() without
// moving the view. When there's no scrollback both calls are no-ops, but then there is
// nothing to scroll anyway, so this is safe in every state.
const resyncTerminalViewport = (terminal: Terminal) => {
  terminal.scrollLines(-1);
  terminal.scrollLines(1);
};

interface TerminalPaneProps {
  sessionId: string;
  maximized?: boolean;
  // Whether this pane's workspace is the one currently on screen. Panes in hidden
  // workspaces stay mounted (so switching back never re-creates them) but give up their
  // WebGL renderer while off-screen — see the `active` effect below.
  active?: boolean;
}

const TerminalPaneComponent: React.FC<TerminalPaneProps> = ({ sessionId, maximized, active = true }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const settleTimeoutRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglReleaseRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const currentProjectPath = useProjectStore((state) => state.currentProjectPath);
  const setActiveView = useProjectStore((state) => state.setActiveView);
  const linkedTask = useKanbanStore((state) => state.tasks.find(t => t.terminalId === sessionId));
  const focusedPaneId = useTerminalStore((state) => state.focusedPaneId);
  const setFocusedPane = useTerminalStore((state) => state.setFocusedPane);
  const addPane = useTerminalStore((state) => state.addPane);
  const removePane = useTerminalStore((state) => state.removePane);
  const toggleMaximizePane = useTerminalStore((state) => state.toggleMaximizePane);
  const canAddPane = useTerminalStore((state) => state.canAddPane);
  const sessionInfo = useTerminalStore((state) => state.sessions[sessionId]);
  const isWaitingReview = useTerminalStore((state) => state.reviewPanes[sessionId]);
  const resolveReview = useTerminalStore((state) => state.resolveReview);
  
  const setActiveTaskId = useReviewStore((state) => state.setActiveTaskId);
  const createReviewRecord = useReviewStore((state) => state.createReviewRecord);
  const submitReviewDecision = useReviewStore((state) => state.submitReviewDecision);

  const themeMode = useThemeStore((state) => state.mode);
  const fontId = useTerminalFontStore((state) => state.fontId);

  // Keep the live xterm theme in sync with the app theme (xterm needs a JS theme object).
  useEffect(() => {
    const apply = () => {
      if (terminalRef.current) {
        terminalRef.current.options.theme = { ...terminalThemeFor(resolveTheme(themeMode)) };
      }
    };
    apply();
    if (themeMode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [themeMode]);

  // Apply the chosen terminal font live. Changing the face changes the cell metrics, so
  // re-measure with the fit addon and push the new cols/rows to the PTY (the same path the
  // ResizeObserver uses) — otherwise the prompt would stay sized to the previous font.
  useEffect(() => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term) return;

    term.options.fontFamily = fontStackFor(fontId);

    const container = containerRef.current;
    if (!fitAddon || !container || container.clientHeight < 1 || container.clientWidth < 1) {
      // Container not laid out (hidden view, mid-mount); just repaint at the new metrics.
      term.refresh(0, term.rows - 1);
      return;
    }

    try {
      const nextSize = fitAddon.proposeDimensions();
      if (nextSize && nextSize.rows >= 1 && nextSize.cols >= 1) {
        if (term.cols !== nextSize.cols || term.rows !== nextSize.rows) {
          term.resize(nextSize.cols, nextSize.rows);
        }
        lastSizeRef.current = nextSize;
        invoke('resize_pty', { id: sessionId, cols: nextSize.cols, rows: nextSize.rows })
          .catch((err) => console.error('PTY resize on font change failed:', err));
      }
      term.refresh(0, term.rows - 1);
    } catch (err) {
      console.warn('Font-change refit warning:', err);
    }
  }, [fontId, sessionId]);

  const isFocused = focusedPaneId === sessionId;
  const canCreatePane = Boolean(currentProjectPath && canAddPane());

  // Drop this pane's WebGL renderer (if any) and free its slot in the global context
  // budget. Idempotent: safe to call from the `active` effect, the context-loss handler,
  // and the unmount cleanup without double-counting.
  const unloadWebgl = useCallback(() => {
    const held = webglHolders.has(sessionId) || webglAddonRef.current !== null;
    webglHolders.delete(sessionId);
    if (webglReleaseRef.current) {
      webglReleaseRef.current();
      webglReleaseRef.current = null;
    }
    if (webglAddonRef.current) {
      try {
        webglAddonRef.current.dispose();
      } catch {
        // Already disposed (e.g. via context loss) — ignore.
      }
      webglAddonRef.current = null;
    }
    if (held) webglDiag('release', sessionId);
  }, [sessionId]);

  // Attach a WebGL renderer to the live terminal, unless one is already attached or the
  // per-process context budget is spent (then the pane keeps xterm's slower DOM renderer).
  const loadWebgl = useCallback(() => {
    const term = terminalRef.current;
    if (!term || webglAddonRef.current) return;
    if (isWebglDisabled()) {
      webglDiag('disabled-dom-renderer', sessionId);
      return;
    }
    if (activeWebglContexts >= MAX_WEBGL_CONTEXTS) {
      // Budget spent. Only the focused/maximized pane (the one actually on screen) may reclaim a
      // context; any other pane keeps the DOM renderer. Evicting a non-focused holder frees a slot
      // for the pane the user is looking at.
      const { focusedPaneId, maximizedPaneId } = useTerminalStore.getState();
      const isPriority = sessionId === focusedPaneId || sessionId === maximizedPaneId;
      const victim = isPriority
        ? Array.from(webglHolders.keys()).find(
            (id) => id !== sessionId && id !== focusedPaneId && id !== maximizedPaneId,
          )
        : undefined;
      if (!victim) {
        webglDiag('cap-reached-dom-fallback', sessionId, { isPriority });
        console.warn(
          `[terminal ${sessionId}] WebGL context cap (${MAX_WEBGL_CONTEXTS}) reached; this pane uses the slower DOM renderer.`,
        );
        return;
      }
      // Release the victim's context (drops it back to the DOM renderer), freeing a slot.
      webglDiag('evict', sessionId, { victim });
      webglHolders.get(victim)?.();
      if (activeWebglContexts >= MAX_WEBGL_CONTEXTS) return;
    }
    try {
      const webglAddon = new WebglAddon();
      activeWebglContexts += 1;
      webglHolders.set(sessionId, unloadWebgl);
      let released = false;
      webglReleaseRef.current = () => {
        if (released) return;
        released = true;
        activeWebglContexts = Math.max(0, activeWebglContexts - 1);
      };
      webglAddonRef.current = webglAddon;
      webglAddon.onContextLoss(() => {
        // The browser reclaimed the GL context (e.g. the process-wide cap was hit). Drop the
        // addon and free the slot so the pane falls back to the DOM renderer instead of
        // sitting on a dead, frozen canvas.
        webglDiag('context-loss', sessionId);
        unloadWebgl();
      });
      term.loadAddon(webglAddon);
      term.refresh(0, term.rows - 1);
      webglDiag('acquire', sessionId);
    } catch {
      // WebGL not supported / failed to init — fall back to the DOM renderer.
      unloadWebgl();
      webglDiag('init-failed-dom-fallback', sessionId);
      console.warn(
        `[terminal ${sessionId}] WebGL renderer unavailable; using the slower DOM renderer.`,
      );
    }
  }, [sessionId, unloadWebgl]);

  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false;
    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      // Initial face read straight from the store; a dedicated effect below re-applies
      // and re-fits when the user picks a different font from the Terminal Controls panel.
      fontFamily: fontStackFor(useTerminalFontStore.getState().fontId),
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.15,
      scrollback: TERMINAL_SCROLLBACK_ROWS,
      theme: { ...getTerminalTheme() },
      allowProposedApi: true,
      // Make xterm grow rows into the scrollback the way ConPTY expects, so maximizing the
      // window keeps the existing output instead of replacing it with empty rows.
      ...(IS_WINDOWS_PTY ? { windowsPty: { backend: 'conpty' as const } } : {}),
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    term.attachCustomKeyEventHandler((event) => {
      // Ctrl/Cmd+F opens the pane's find bar instead of reaching the shell.
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'f'
      ) {
        event.preventDefault();
        event.stopPropagation();
        setSearchOpen(true);
        return false;
      }

      if (!isTerminalCopyShortcut(event)) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();

      if (term.hasSelection()) {
        void copyTextToClipboard(term.getSelection());
      }

      return false;
    });

    term.open(containerRef.current);

    // open() attaches the renderer; harden its dimensions getter so a later renderer
    // teardown/swap can't make a queued Viewport._sync() throw mid-refresh (see
    // guardRenderServiceDimensions) — the cause of the intermittent blank-band artifacts.
    guardRenderServiceDimensions(term);

    // The WebGL renderer is acquired lazily and only while this pane's workspace is the one
    // on screen (see the `active` effect below). Loading it here at mount — for every pane in
    // every open workspace — would exhaust the browser's hard WebGL context cap and thrash the
    // GPU compositor on each workspace switch (panes froze until the next keypress).

    const applyInitialSize = (retries = 8, delay = 100) => {
      if (disposed) return;
      try {
        const container = containerRef.current;
        const nextSize = container && container.clientHeight >= 1 && container.clientWidth >= 1
          ? fitAddon.proposeDimensions()
          : undefined;
        if (!nextSize || nextSize.rows < 1 || nextSize.cols < 1) {
          // Container isn't laid out yet — panes commonly mount into a 0-height grid cell
          // when several open at once. Retry until it has real dimensions so we never size
          // the PTY to a degenerate ~1-row value.
          if (retries > 0) {
            setTimeout(() => applyInitialSize(retries - 1, delay * 1.5), delay);
          }
          return;
        }

        if (term.cols !== nextSize.cols || term.rows !== nextSize.rows) {
          term.resize(nextSize.cols, nextSize.rows);
        }

        lastSizeRef.current = nextSize;
        invoke('resize_pty', {
          id: sessionId,
          cols: nextSize.cols,
          rows: nextSize.rows
        }).catch(err => {
          if (retries > 0 && String(err).includes('not found')) {
            setTimeout(() => applyInitialSize(retries - 1, delay * 1.5), delay);
          } else {
            console.error('Initial PTY resize failed:', err);
          }
        });
      } catch (e) {
        console.warn('Initial xterm fit warning:', e);
      }
    };
    applyInitialSize();

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Reconstruct the typed command line from keystrokes so the hover "N cmd" badge reflects what
    // the user actually ran — not shell output. This runs only on input (rare), so it never
    // re-renders the pane during output streaming. Escape/CSI sequences (arrows, fn keys) are
    // skipped, Backspace edits the line, and Enter commits it via `recordCommand`.
    let pendingCommandLine = '';
    let inEscape = false;
    const trackTypedCommand = (input: string) => {
      for (const ch of input) {
        if (inEscape) {
          // A CSI/SS3 sequence ends on its final byte (0x40–0x7E), excluding the `[`/`O`
          // introducer that immediately follows ESC.
          if (ch !== '[' && ch !== 'O' && ch >= '@' && ch <= '~') inEscape = false;
          continue;
        }
        if (ch === '\x1b') {
          inEscape = true;
        } else if (ch === '\r' || ch === '\n') {
          const line = pendingCommandLine.trim();
          pendingCommandLine = '';
          if (line) useTerminalStore.getState().recordCommand(sessionId, line);
        } else if (ch === '\x7f' || ch === '\b') {
          pendingCommandLine = pendingCommandLine.slice(0, -1);
        } else if (ch >= ' ') {
          pendingCommandLine += ch;
        }
        // Other control chars (Ctrl-C, Tab, …) are ignored for the badge.
      }
    };

    const dataDisposable = term.onData((data) => {
      if (useTerminalStore.getState().reviewPanes[sessionId]) return;

      trackTypedCommand(data);

      invoke('write_pty', { id: sessionId, data }).catch((err) => {
        console.error('Failed to write to PTY:', err);
      });
    });

    // Mirror the OSC title the running program sets (Claude Code, vim, ssh, …) into the
    // pane tab so each session shows what it's working on instead of a static label.
    const titleDisposable = term.onTitleChange((title) => {
      const clean = title.trim();
      useTerminalStore.getState().updateSession(sessionId, { dynamicTitle: clean || undefined });
    });

    const terminalState = useTerminalStore.getState();
    const bufferedOutput = terminalState.getBufferedOutput(sessionId);
    let lastOutputSequence = terminalState.getLatestSequence(sessionId);

    // Replay the buffered scrollback in rAF-sized slices instead of one large write,
    // so re-entering the Terminals view with many panes doesn't enqueue hundreds of KB
    // synchronously per pane. Live output that arrives mid-replay is queued and flushed
    // afterwards to preserve ordering (replay covers up to lastOutputSequence; live
    // events have a higher sequence).
    let replayDone = bufferedOutput.length === 0;
    const liveQueue: string[] = [];

    const unsubscribeOutput = useTerminalStore.getState().subscribeOutput(sessionId, (paneOutput) => {
      if (paneOutput.sequence === lastOutputSequence) return;
      lastOutputSequence = paneOutput.sequence;
      if (!replayDone) {
        liveQueue.push(paneOutput.data);
        return;
      }
      term.write(paneOutput.data);
    });

    if (!replayDone) {
      const REPLAY_CHUNK = 32 * 1024;
      let offset = 0;
      const writeReplayChunk = () => {
        if (disposed) return;
        term.write(bufferedOutput.slice(offset, offset + REPLAY_CHUNK));
        offset += REPLAY_CHUNK;
        if (offset < bufferedOutput.length) {
          window.requestAnimationFrame(writeReplayChunk);
        } else {
          replayDone = true;
          if (liveQueue.length > 0) {
            term.write(liveQueue.join(''));
            liveQueue.length = 0;
          }
        }
      };
      writeReplayChunk();
    }

    const fitAndResizePty = () => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const container = containerRef.current;
      if (!fitAddon || !terminal || !container) return;

      // Skip while the container is collapsed/detached (mid-layout, hidden view, etc.).
      // Measuring then would resize the PTY to a degenerate ~1-row size and make PowerShell
      // repaint into a single row, scrolling its banner away.
      if (container.clientHeight < 1 || container.clientWidth < 1) return;

      try {
        const nextSize = fitAddon.proposeDimensions();
        if (!nextSize || nextSize.rows < 1 || nextSize.cols < 1) return;

        const lastSize = lastSizeRef.current;
        if (lastSize?.cols === nextSize.cols && lastSize.rows === nextSize.rows) {
          // Same size means no resize is needed — but this branch is also exactly what runs
          // when a hidden pane is revealed at the unchanged window size (the ResizeObserver
          // fired because the container went 0 -> real). xterm's viewport scroll area is
          // stale after that, so restore wheel scrolling here. Covers the view switch
          // (Terminals -> other room -> Terminals), where the `active` prop never changes.
          resyncTerminalViewport(terminal);
          return;
        }

        const scrollSnapshot = captureTerminalScroll(terminal);
        if (terminal.cols !== nextSize.cols || terminal.rows !== nextSize.rows) {
          // Resize xterm with the SAME measurement we send to the PTY below. Using
          // fitAddon.fit() here would re-run proposeDimensions() and could resize xterm
          // to a different size than the PTY was told, leaving the prompt vertically offset.
          // refresh() forces the WebGL renderer to repaint at the new dimensions.
          terminal.resize(nextSize.cols, nextSize.rows);
          terminal.refresh(0, terminal.rows - 1);
          restoreTerminalScroll(terminal, scrollSnapshot);
        }

        lastSizeRef.current = nextSize;
        invoke('resize_pty', {
          id: sessionId,
          cols: nextSize.cols,
          rows: nextSize.rows,
        }).catch(e => console.error('PTY resize on layout change failed:', e));
      } catch (err) {
        // Ignored when elements are momentarily detached
      }
    };

    const scheduleFitAndResizePty = () => {
      // Trailing debounce: a window maximize/restore is animated and fires dozens of
      // ResizeObserver callbacks in a burst. Resizing the PTY on each one makes Windows
      // ConPTY repaint (clear + redraw) repeatedly, which scrolls the banner away and leaves
      // the prompt mis-positioned. Coalesce the whole burst into a SINGLE fit + PTY resize
      // once the size has settled.
      if (settleTimeoutRef.current !== null) {
        window.clearTimeout(settleTimeoutRef.current);
      }
      settleTimeoutRef.current = window.setTimeout(() => {
        settleTimeoutRef.current = null;
        fitAndResizePty();
      }, 120);
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleFitAndResizePty();
    });

    resizeObserver.observe(containerRef.current);

    if (isFocused) {
      term.focus();
    }

    return () => {
      disposed = true;
      if (settleTimeoutRef.current !== null) {
        window.clearTimeout(settleTimeoutRef.current);
      }
      resizeObserver.disconnect();
      dataDisposable.dispose();
      titleDisposable.dispose();
      unsubscribeOutput();
      unloadWebgl();
      searchAddonRef.current = null; // disposed with the terminal
      term.dispose();
    };
  }, [sessionId]);

  // Focus the find bar as soon as it opens (Ctrl+F inside xterm can't focus a React input
  // synchronously — the overlay mounts on the next render).
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const runSearch = (direction: 'next' | 'previous', query = searchQuery) => {
    const addon = searchAddonRef.current;
    if (!addon || !query) return;
    if (direction === 'next') addon.findNext(query, { incremental: false });
    else addon.findPrevious(query, { incremental: false });
  };

  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    // Incremental: extend the current match as the user types instead of jumping ahead.
    if (value) searchAddonRef.current?.findNext(value, { incremental: true });
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
    try {
      searchAddonRef.current?.clearDecorations();
    } catch {
      // Addon may already be disposed with its terminal — nothing to clear.
    }
    terminalRef.current?.focus();
  };

  // Acquire/release the WebGL renderer as this pane's workspace gains/loses visibility.
  // Acquisition is deferred one frame so the outgoing workspace's panes release their
  // contexts first — that ordering is what keeps a switch from momentarily exceeding the
  // browser's hard context cap (the cause of the post-switch scroll/render freeze).
  useEffect(() => {
    if (!active) {
      unloadWebgl();
      return;
    }
    const raf = window.requestAnimationFrame(() => {
      loadWebgl();
      const term = terminalRef.current;
      if (term) {
        // While hidden the container was display:none, so its size-guarded ResizeObserver
        // may not fire on reveal (dimensions unchanged). Force one repaint so the pane shows
        // current content immediately instead of staying blank until the next PTY write,
        // and re-sync the scroll viewport so the mouse wheel works without a keypress.
        term.refresh(0, term.rows - 1);
        resyncTerminalViewport(term);
      }
    });
    return () => window.cancelAnimationFrame(raf);
  }, [active, loadWebgl, unloadWebgl]);

  useEffect(() => {
    if (isFocused && terminalRef.current) {
      terminalRef.current.focus();
      // If this pane is on the DOM renderer only because the context budget was full when it
      // mounted, now that it's focused it can reclaim a context from a non-focused pane. No-op if
      // it already holds one, or if its workspace isn't on screen.
      if (active) loadWebgl();
    }
  }, [isFocused, active, loadWebgl]);

  const handleContainerClick = () => {
    if (!isFocused) {
      setFocusedPane(sessionId);
    }
  };

  const handleTitleAction = (event: React.MouseEvent<HTMLButtonElement>, action: () => void | Promise<void>) => {
    event.stopPropagation();
    setFocusedPane(sessionId);
    void action();
  };

  const handleAddPane = () => {
    const cwd = sessionInfo?.workspacePath || sessionInfo?.cwd || currentProjectPath;
    if (!cwd || !canAddPane()) return;
    // Inherit the parent's model too (matches splitPane's inheritance) — passing undefined
    // here dropped the model and relaunched the provider's default.
    void addPane(cwd, sessionInfo?.aiProvider, sessionInfo?.model, undefined, sessionInfo?.customCommand);
  };

  const handleRemovePane = () => {
    void removePane(sessionId);
  };

  const handleApprove = async () => {
    if (!linkedTask || !currentProjectPath) return;
    try {
      await createReviewRecord(currentProjectPath, linkedTask.id, sessionId);
      await submitReviewDecision(currentProjectPath, linkedTask.id, 'approve');
      resolveReview(sessionId);
      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      await useAgentSessionStore.getState().loadSessions(currentProjectPath, true);
    } catch (err) {
      console.error('Approve failed:', err);
    }
    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  };

  const handleReject = async () => {
    if (!linkedTask || !currentProjectPath) return;
    try {
      await createReviewRecord(currentProjectPath, linkedTask.id, sessionId);
      await submitReviewDecision(currentProjectPath, linkedTask.id, 'reject', 'Rejected from terminal overlay');
      resolveReview(sessionId);

      try {
        await invoke('write_pty', {
          id: sessionId,
          data: '\r# Review Rejected. Resuming task correction...\r'
        });
      } catch (e) {
        console.error('Failed to notify shell:', e);
      }

      await useKanbanStore.getState().loadTasks(currentProjectPath, true);
      await useAgentSessionStore.getState().loadSessions(currentProjectPath, true);
    } catch (err) {
      console.error('Reject failed:', err);
    }

    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  };

  const paneColor = sessionInfo?.groupColor || '#5D5FEF';
  // Only Claude Code shows a live, dynamic title — it mirrors the OSC title its CLI sets
  // (current task, etc.) into dynamicTitle. Every other pane shows the name of the folder
  // it was spawned in, since their CLIs emit noisy titles (Pi spams its startup command;
  // plain shells emit the full cwd path).
  const shellLabel = IS_WINDOWS_PTY ? 'PowerShell' : 'Terminal';
  const folderName =
    sessionInfo?.cwd?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || shellLabel;
  const paneTitle =
    sessionInfo?.aiProvider === 'claude'
      ? sessionInfo?.dynamicTitle || 'Claude Code'
      : folderName;

  return (
    <div
      onClick={handleContainerClick}
      className={`terminal-pane ${maximized ? 'terminal-pane-maximized' : ''}`}
      style={{
        '--terminal-pane-color': paneColor,
      } as React.CSSProperties}
      data-focused={isFocused ? 'true' : 'false'}
    >
      <div className="terminal-pane-titlebar">
        <div className="terminal-pane-title" title={paneTitle}>
          <span>{paneTitle}</span>
        </div>
        <div className="terminal-pane-title-actions">
          <button
            className="terminal-pane-title-button"
            onClick={(e) => handleTitleAction(e, handleAddPane)}
            disabled={!canCreatePane}
            title={canCreatePane ? 'Open matching terminal pane' : 'Pane limit reached'}
            aria-label="Open matching terminal pane"
          >
            <GitBranch size={14} />
          </button>
          <button
            className="terminal-pane-title-button"
            onClick={(e) => handleTitleAction(e, () => toggleMaximizePane(sessionId))}
            title={maximized ? 'Restore to grid' : 'Maximize this pane'}
            aria-label={maximized ? 'Restore terminal pane to grid' : 'Maximize terminal pane'}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            className="terminal-pane-title-button"
            onClick={(e) => handleTitleAction(e, handleRemovePane)}
            title="Close this terminal pane"
            aria-label="Close this terminal pane"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="terminal-xterm-container"
      />

      {searchOpen && (
        <div className="terminal-search-overlay">
          <Search size={12} aria-hidden />
          <input
            ref={searchInputRef}
            className="terminal-search-input"
            value={searchQuery}
            placeholder="Find in terminal"
            spellCheck={false}
            onChange={(e) => handleSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                runSearch(e.shiftKey ? 'previous' : 'next');
              } else if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button
            className="terminal-pane-title-button"
            onClick={() => runSearch('previous')}
            title="Previous match (Shift+Enter)"
            aria-label="Previous match"
          >
            <ChevronUp size={13} />
          </button>
          <button
            className="terminal-pane-title-button"
            onClick={() => runSearch('next')}
            title="Next match (Enter)"
            aria-label="Next match"
          >
            <ChevronDown size={13} />
          </button>
          <button
            className="terminal-pane-title-button"
            onClick={closeSearch}
            title="Close search (Esc)"
            aria-label="Close search"
          >
            <X size={13} />
          </button>
        </div>
      )}

      {isWaitingReview && linkedTask && (
        <div className="terminal-review-overlay">
          <div className="terminal-review-content">
            <div className="terminal-review-title">Review Gate: {linkedTask.title}</div>
            <div className="terminal-review-description">Agent execution complete. Verify changes before committing.</div>
          </div>
          <div className="terminal-review-actions">
            <button 
              onClick={() => {
                setActiveTaskId(linkedTask.id);
                setActiveView('review');
              }} 
              className="terminal-review-open-room secondary"
              style={{
                marginRight: '8px',
                background: 'rgba(255, 255, 255, 0.1)',
                border: '1px solid rgba(255, 255, 255, 0.2)',
                color: 'var(--text-secondary)',
                padding: '4px 8px',
                borderRadius: '4px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                fontSize: '12px',
                fontWeight: 500,
                transition: 'background 0.2s',
              }}
            >
              Open Review Room
            </button>
            <button onClick={handleReject} className="terminal-review-reject">
              <XCircle size={14} />
              <span>Reject</span>
            </button>
            <button onClick={handleApprove} className="primary terminal-review-approve">
              <Check size={14} />
              <span>Approve</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const TerminalPane = memo(TerminalPaneComponent);
