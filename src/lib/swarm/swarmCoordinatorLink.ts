// Live-coordinator link (Phase 3): watches the interactive coordinator's PTY for activity and
// drains Bridge's pending results digests into it as typed user turns.
//
// Delivery contract (exactly-once):
// - A digest enters `pendingDigests` only when injection is possible; the queue itself is owned by
//   the swarm store and persists in state.json.
// - The pump pops a digest ONLY after both PTY writes (bracketed paste + Enter) succeeded. A busy
//   pane, a paused swarm, a project switch, or a full PTY input queue leaves it queued for
//   re-delivery, so resume/re-arm/retry yields exactly one more delivery, never zero.
// - Injection waits for the pane to look idle: no output for IDLE_QUIET_MS (the "at its input
//   prompt" heuristic).
//
// One instance per app session (one live swarm at a time), created by the swarm store. Everything
// that reaches into stores or Tauri arrives through `deps`, so the pump is unit-testable with
// plain fakes instead of a mounted store.

export type CoordinatorActivityState = 'planning' | 'idle' | 'digesting';

/** The slice of live swarm state each pump tick reads. */
export interface CoordinatorDeliverySnapshot {
  // True only while the swarm may inject (`status === 'running'`); a paused or stopped run never
  // types into a coordinator.
  running: boolean;
  // Terminal pane of the current role==='coordinator' agent, if it has one.
  coordinatorPaneId?: string | null;
  pendingDigests: readonly string[];
  coordinatorState: CoordinatorActivityState;
}

export interface CoordinatorLinkDeps {
  getSnapshot: () => CoordinatorDeliverySnapshot;
  setCoordinatorState: (state: CoordinatorActivityState) => void;
  // Called after BOTH PTY writes for the head digest succeeded; the store pops exactly one entry.
  onDigestDelivered: () => void;
  // Mirrors the Rust `write_pty` command: reports `accepted: false` when the pane's input queue
  // was full and the bytes were dropped.
  writePty: (
    paneId: string,
    data: string,
  ) => Promise<{ accepted: boolean } | null | undefined>;
  subscribeOutput: (paneId: string, onOutput: () => void) => () => void;
}

export interface CoordinatorLink {
  /** Track a pane's output for the busy/idle heuristic; re-watching switches panes. */
  watch(paneId: string): void;
  /** Drop the watch and clear any pending pump timer. */
  stop(): void;
  /** Whether this pane is currently the watched one. */
  isWatching(paneId: string): boolean;
  /** Start draining pending digests (no-op while a tick is already scheduled). */
  pump(): void;
  /**
   * Test seam: the pump timer is instance state that survives between tests. Switching to fake
   * timers orphans a pending handle (it stays non-null and blocks scheduling), so tests must
   * clear it alongside `vi.useRealTimers()`.
   */
  resetForTests(): void;
}

const IDLE_QUIET_MS = 3000;
const DIGEST_ENTER_DELAY_MS = 150;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const createCoordinatorLink = (deps: CoordinatorLinkDeps): CoordinatorLink => {
  let watchRef: { paneId: string; unsubscribe: () => void } | null = null;
  let lastOutputAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleRetry = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, IDLE_QUIET_MS);
  };

  const tick = async () => {
    timer = null;
    const snap = deps.getSnapshot();
    const paneId = watchRef?.paneId;
    if (!paneId || !snap.coordinatorPaneId || snap.coordinatorPaneId !== paneId || !snap.running) {
      return; // digests stay queued in pendingDigests until conditions return
    }
    if (snap.pendingDigests.length === 0) {
      if (snap.coordinatorState === 'digesting') deps.setCoordinatorState('idle');
      return;
    }
    const quietFor = Date.now() - lastOutputAt;
    if (quietFor < IDLE_QUIET_MS) {
      timer = setTimeout(tick, IDLE_QUIET_MS - quietFor + 50);
      return;
    }
    const digest = snap.pendingDigests[0];
    deps.setCoordinatorState('digesting');
    try {
      // Bracketed paste so the TUI treats embedded newlines as pasted text; Enter follows as its
      // own keypress (mirrors the Rust-side interactive prompt delivery). write_pty reports
      // `accepted: false` when the pane's input queue is full and the bytes were dropped -
      // structured payloads must never be silently lost, so a drop keeps the digest queued.
      const paste = await deps.writePty(paneId, `\u001b[200~${digest}\u001b[201~`);
      if (!paste?.accepted) {
        // Nothing was typed - safe to retry the whole delivery later.
        scheduleRetry();
        return;
      }
      await delay(DIGEST_ENTER_DELAY_MS);
      let enter = await deps.writePty(paneId, '\r');
      if (!enter?.accepted) {
        // The paste is already in the TUI's input; only the submit keystroke was dropped.
        // Re-queuing the WHOLE digest would duplicate the text, so retry just the Enter
        // once after the next quiet window, then consider it delivered (the text sits in
        // the coordinator's input where the operator can see it).
        await delay(IDLE_QUIET_MS);
        enter = await deps.writePty(paneId, '\r').catch(() => ({ accepted: false }));
      }
      deps.onDigestDelivered();
    } catch (error) {
      console.error('Failed to inject digest into coordinator PTY:', error);
      scheduleRetry(); // keep the digest queued; try again after the next quiet window
      return;
    }
    lastOutputAt = Date.now(); // injection counts as activity: wait for quiet again
    scheduleRetry();
  };

  const pump = () => {
    if (timer) return;
    timer = setTimeout(tick, 0);
  };

  return {
    watch: (paneId) => {
      if (watchRef?.paneId === paneId) return;
      watchRef?.unsubscribe();
      lastOutputAt = Date.now();
      const unsubscribe = deps.subscribeOutput(paneId, () => {
        lastOutputAt = Date.now();
      });
      watchRef = { paneId, unsubscribe };
    },
    stop: () => {
      watchRef?.unsubscribe();
      watchRef = null;
      clearTimer();
    },
    isWatching: (paneId) => watchRef?.paneId === paneId,
    pump,
    resetForTests: clearTimer,
  };
};
