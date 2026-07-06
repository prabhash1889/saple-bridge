import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { readText } from '@tauri-apps/plugin-clipboard-manager';
import { useTerminalStore } from '../../stores/terminalStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { writeTextToClipboard } from '../../lib/clipboard';
import { useThemeStore, resolveTheme } from '../../stores/themeStore';
import { useTerminalFontStore, fontStackFor } from '../../stores/terminalFontStore';
import { getTerminalTheme, terminalThemeFor } from './terminalThemes';
import {
  copyTerminalSelection,
  isTerminalCopyShortcut,
  matchesShortcutLetter,
} from './terminalClipboard';
import {
  MAX_WEBGL_CONTEXTS,
  decrementActiveWebglContexts,
  getActiveWebglContexts,
  incrementActiveWebglContexts,
  isWebglDisabled,
  webglDiag,
  webglHolders,
} from './webglBudget';
import '@xterm/xterm/css/xterm.css';

// On Windows the PTY backend is ConPTY (pty.rs spawns powershell.exe). ConPTY repaints on
// resize and, when rows grow, pushes the previous rows into the scrollback rather than
// leaving the viewport content in place. xterm only matches that model when told it's
// talking to a Windows pty — without it, growing the terminal (e.g. maximizing the window)
// REPLACES the existing rows and the shell banner/history is lost. Detect Windows from the
// WebView user agent (no extra deps) and pass it to the Terminal below.
export const IS_WINDOWS_PTY = typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent);

// Writes go through the shared helper (Tauri plugin with retry for Windows clipboard lock
// contention, navigator.clipboard as fallback) and REJECT on total failure, so
// copyTerminalSelection keeps the selection highlighted and this toast tells the user -
// instead of the copy silently vanishing (the "sometimes Ctrl+C doesn't copy" report).
const copyTextToClipboard = (text: string) => writeTextToClipboard(text);

const notifyCopyFailed = (error: unknown) => {
  console.error('Failed to copy terminal selection:', error);
  useNotificationStore
    .getState()
    .warning('Copy failed', 'The clipboard was busy or unavailable. The text is still selected - try again.');
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

export interface UseXtermSessionOptions {
  sessionId: string;
  // Whether this pane's workspace is the one currently on screen. Panes in hidden
  // workspaces stay mounted (so switching back never re-creates them) but give up their
  // WebGL renderer while off-screen — see the `active` effect below.
  active: boolean;
  isFocused: boolean;
  // Called when the user presses Ctrl/Cmd+F inside the terminal to open the find bar.
  onSearchOpen: () => void;
}

// The giant terminal-session lifecycle: xterm init + addons, scrollback replay, PTY wiring,
// resize handling, theme/font sync, and the WebGL context budget dance. Extracted from
// TerminalPane so the component only owns the chrome around the terminal.
export function useXtermSession({ sessionId, active, isFocused, onSearchOpen }: UseXtermSessionOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const settleTimeoutRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglReleaseRef = useRef<(() => void) | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // The mount effect below runs once per session; route the latest onSearchOpen through a
  // ref so the Ctrl+F handler never captures a stale callback.
  const onSearchOpenRef = useRef(onSearchOpen);
  onSearchOpenRef.current = onSearchOpen;

  const themeMode = useThemeStore((state) => state.mode);
  const fontId = useTerminalFontStore((state) => state.fontId);
  const fontSize = useTerminalFontStore((state) => state.fontSize);
  const scrollbackRows = useTerminalFontStore((state) => state.scrollbackRows);

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

  // Live scrollback resize (Settings > Workspace). Only the retained-history depth changes,
  // so no re-fit or PTY resize is needed — xterm reflows its own buffer.
  useEffect(() => {
    const term = terminalRef.current;
    if (term) term.options.scrollback = scrollbackRows;
  }, [scrollbackRows]);

  // Apply the chosen terminal font + size live. Both change the cell metrics, so re-measure
  // with the fit addon and push the new cols/rows to the PTY (the same path the
  // ResizeObserver uses) — otherwise the prompt would stay sized to the previous metrics.
  useEffect(() => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term) return;

    term.options.fontFamily = fontStackFor(fontId);
    term.options.fontSize = fontSize;

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
  }, [fontId, fontSize, sessionId]);

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
    if (getActiveWebglContexts() >= MAX_WEBGL_CONTEXTS) {
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
      if (getActiveWebglContexts() >= MAX_WEBGL_CONTEXTS) return;
    }
    try {
      const webglAddon = new WebglAddon();
      incrementActiveWebglContexts();
      webglHolders.set(sessionId, unloadWebgl);
      let released = false;
      webglReleaseRef.current = () => {
        if (released) return;
        released = true;
        decrementActiveWebglContexts();
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
      // Initial face/size/scrollback read straight from the store; the dedicated effects
      // above re-apply and re-fit when the user changes any of them.
      fontSize: useTerminalFontStore.getState().fontSize,
      fontFamily: fontStackFor(useTerminalFontStore.getState().fontId),
      fontWeight: 400,
      fontWeightBold: 700,
      letterSpacing: 0,
      lineHeight: 1.15,
      scrollback: useTerminalFontStore.getState().scrollbackRows,
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

    // Make URLs in the buffer clickable; open them through the OS default browser via the
    // opener plugin (never inside the WebView). Underlines the link on hover only.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        void openUrl(uri).catch((err) => console.error('Failed to open URL:', err));
      }),
    );

    term.attachCustomKeyEventHandler((event) => {
      // Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 adjust the app-wide terminal font size. Handled
      // here (not in the shell) so the size change never reaches the running program. The
      // font effect above re-fits every pane to the new metrics.
      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey
      ) {
        const fontStore = useTerminalFontStore.getState();
        if (event.key === '=' || event.key === '+') {
          event.preventDefault();
          event.stopPropagation();
          fontStore.increaseFontSize();
          return false;
        }
        if (event.key === '-' || event.key === '_') {
          event.preventDefault();
          event.stopPropagation();
          fontStore.decreaseFontSize();
          return false;
        }
        if (event.key === '0') {
          event.preventDefault();
          event.stopPropagation();
          fontStore.resetFontSize();
          return false;
        }
      }

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
        onSearchOpenRef.current();
        return false;
      }

      // Plain Ctrl+V: stock xterm swallows this into the raw 0x16 control byte and no
      // paste ever happens (the keydown is preventDefault-ed, so the WebView's native
      // paste never fires). Intercept it: when the clipboard holds text, insert it via
      // xterm's paste path (bracketed paste - works in every TUI); when it holds no
      // text, forward the original 0x16 so TUIs with their own Ctrl+V bindings (codex/
      // Claude Code image paste) still see the keystroke. Ctrl+Shift+V is untouched -
      // it rides the WebView's native paste event. Matched via matchesShortcutLetter:
      // synthetic Ctrl+V (SendInput with no scan code, e.g. voice-to-text injectors)
      // arrives with code:"" and would bypass a code-only check.
      if (
        event.type === 'keydown' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        matchesShortcutLetter(event, 'v', 'KeyV')
      ) {
        event.preventDefault();
        event.stopPropagation();
        readText()
          .then((text) => {
            if (text) {
              term.paste(text);
            } else {
              term.input('\x16', true);
            }
          })
          .catch(() => {
            // Clipboard empty or non-text (e.g. an image) — behave like stock xterm.
            term.input('\x16', true);
          });
        return false;
      }

      // Plain Ctrl+C with an active selection copies it instead of sending SIGINT
      // (Windows Terminal / VS Code convention). The selection is dismissed so an
      // immediate second Ctrl+C still interrupts the running process as usual.
      if (
        event.type === 'keydown' &&
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        matchesShortcutLetter(event, 'c', 'KeyC') &&
        term.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        // Return false unconditionally: the user saw a highlighted selection when they
        // pressed Ctrl+C, so a copy that comes back empty or fails must never fall through
        // to the raw 0x03 - that would SIGINT the running program instead of copying.
        copyTerminalSelection(term, copyTextToClipboard, {
          clearSelection: true,
          onCopyFailed: notifyCopyFailed,
        });
        return false;
      }

      if (!isTerminalCopyShortcut(event)) {
        return true;
      }

      event.preventDefault();
      event.stopPropagation();

      copyTerminalSelection(term, copyTextToClipboard, { onCopyFailed: notifyCopyFailed });
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
      } catch {
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

    if (useTerminalStore.getState().focusedPaneId === sessionId) {
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

  useEffect(() => {
    if (!active) return;

    const handleWindowKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalCopyShortcut(event)) return;

      // Every active pane registers this fallback listener, and stopPropagation() does NOT
      // silence sibling listeners on the same target (window). Ungated, every pane with a
      // lingering selection would issue a clipboard write and the async writes would race -
      // sometimes a stale selection from another pane won, which read as "copy didn't work".
      // Only the logically focused pane (set on pane click, valid even when DOM focus is
      // elsewhere) responds, and stopImmediatePropagation keeps the remaining listeners out.
      if (useTerminalStore.getState().focusedPaneId !== sessionId) return;

      const term = terminalRef.current;
      if (!term || !copyTerminalSelection(term, copyTextToClipboard, { onCopyFailed: notifyCopyFailed })) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    return () => window.removeEventListener('keydown', handleWindowKeyDown);
  }, [active, sessionId]);

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

  return { containerRef, terminalRef, searchAddonRef };
}
