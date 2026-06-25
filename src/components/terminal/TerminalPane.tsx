import React, { memo, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { invoke } from '@tauri-apps/api/core';
import {
  Check,
  GitBranch,
  Maximize2,
  Minimize2,
  X,
  XCircle,
  Terminal as TerminalIcon,
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

interface TerminalPaneProps {
  sessionId: string;
  maximized?: boolean;
}

const TerminalPaneComponent: React.FC<TerminalPaneProps> = ({ sessionId, maximized }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const settleTimeoutRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const [showBlockInfo, setShowBlockInfo] = useState(false);

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
  const commandBlocks = sessionInfo?.commandBlocks || [];
  const lastCommand = sessionInfo?.lastCommandInput || '';
  const canCreatePane = Boolean(currentProjectPath && canAddPane());

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

    term.attachCustomKeyEventHandler((event) => {
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

    let releaseWebgl = () => {};
    if (activeWebglContexts < MAX_WEBGL_CONTEXTS) {
      try {
        const webglAddon = new WebglAddon();
        activeWebglContexts += 1;
        let released = false;
        releaseWebgl = () => {
          if (released) return;
          released = true;
          activeWebglContexts = Math.max(0, activeWebglContexts - 1);
        };
        webglAddon.onContextLoss(() => {
          releaseWebgl();
          webglAddon.dispose();
        });
        term.loadAddon(webglAddon);
      } catch {
        // WebGL not supported / failed to init, fall back to DOM renderer
        releaseWebgl();
        console.warn(
          `[terminal ${sessionId}] WebGL renderer unavailable; using the slower DOM renderer.`,
        );
      }
    } else {
      // Past the per-process WebGL context cap: this pane renders with xterm's DOM renderer,
      // which is noticeably slower for heavy output. Surface it so it's visible in DevTools when
      // many panes are open (a canvas-renderer fallback would help here, but no stable
      // @xterm/addon-canvas targets @xterm/xterm v6 yet).
      console.warn(
        `[terminal ${sessionId}] WebGL context cap (${MAX_WEBGL_CONTEXTS}) reached; this pane uses the slower DOM renderer.`,
      );
    }

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

    const dataDisposable = term.onData((data) => {
      if (useTerminalStore.getState().reviewPanes[sessionId]) return;

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
      releaseWebgl();
      term.dispose();
    };
  }, [sessionId]);

  useEffect(() => {
    if (isFocused && terminalRef.current) {
      terminalRef.current.focus();
    }
  }, [isFocused]);

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
    void addPane(cwd, sessionInfo?.aiProvider, undefined, undefined, sessionInfo?.customCommand);
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
      onMouseEnter={() => setShowBlockInfo(true)}
      onMouseLeave={() => setShowBlockInfo(false)}
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

      {showBlockInfo && commandBlocks.length > 0 && (
        <div className="terminal-command-indicator">
          <TerminalIcon size={10} />
          <span>{commandBlocks.length} cmd</span>
          {lastCommand && <span className="terminal-command-last" title={lastCommand}>: {lastCommand.slice(0, 40)}</span>}
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
