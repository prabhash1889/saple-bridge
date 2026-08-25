import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCoordinatorLink, type CoordinatorLinkDeps } from './swarmCoordinatorLink';

// Fakes for every dependency the link reaches through: a mutable snapshot standing in for swarm
// state, a recorded PTY writer, and capturable output subscriptions. `writes` holds ACCEPTED
// writes only; `attempts` records every write call including rejected ones.
const makeHarness = () => {
  const subs = new Map<string, () => void>();
  const attempts: Array<{ paneId: string; data: string }> = [];
  const writes: Array<{ paneId: string; data: string }> = [];
  let accepted = true;
  const state = {
    running: true,
    coordinatorPaneId: 'pane-1' as string | null | undefined,
    pendingDigests: ['DIGEST-A'] as string[],
    coordinatorState: 'idle' as 'planning' | 'idle' | 'digesting',
  };
  let deliveries = 0;
  const deps: CoordinatorLinkDeps = {
    getSnapshot: () => state,
    setCoordinatorState: (s) => {
      state.coordinatorState = s;
    },
    // Mirrors the store's functional pop of the delivered head digest.
    onDigestDelivered: () => {
      deliveries += 1;
      state.pendingDigests = state.pendingDigests.slice(1);
    },
    writePty: async (paneId, data) => {
      attempts.push({ paneId, data });
      if (!accepted) return { accepted: false };
      writes.push({ paneId, data });
      return { accepted: true };
    },
    subscribeOutput: (paneId, onOutput) => {
      subs.set(paneId, onOutput);
      return () => {
        subs.delete(paneId);
      };
    },
  };
  return {
    deps,
    state,
    attempts,
    writes,
    subs,
    deliveries: () => deliveries,
    setAccepted: (v: boolean) => {
      accepted = v;
    },
    emitOutput: (paneId = 'pane-1') => subs.get(paneId)?.(),
  };
};

describe('createCoordinatorLink', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('pane watch', () => {
    it('tracks one pane at a time and unsubscribes on switch and stop', () => {
      const h = makeHarness();
      const link = createCoordinatorLink(h.deps);

      link.watch('pane-1');
      expect(link.isWatching('pane-1')).toBe(true);
      expect(h.subs.has('pane-1')).toBe(true);

      link.watch('pane-2');
      expect(link.isWatching('pane-1')).toBe(false);
      expect(link.isWatching('pane-2')).toBe(true);
      expect(h.subs.has('pane-1')).toBe(false);
      expect(h.subs.has('pane-2')).toBe(true);

      link.watch('pane-2'); // re-watching the same pane keeps the single subscription
      expect([...h.subs.keys()]).toEqual(['pane-2']);

      link.stop();
      expect(link.isWatching('pane-2')).toBe(false);
      expect(h.subs.size).toBe(0);
    });
  });

  describe('digest pump', () => {
    it('delivers a queued digest exactly once after a quiet window, then settles to idle', async () => {
      const h = makeHarness();
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      // One quiet window (3s) plus the paste/Enter gap (150ms).
      await vi.advanceTimersByTimeAsync(3400);

      expect(h.deliveries()).toBe(1);
      expect(h.state.pendingDigests).toEqual([]);
      expect(h.state.coordinatorState).toBe('digesting');
      expect(h.writes[0]).toEqual({
        paneId: 'pane-1',
        data: `\u001b[200~DIGEST-A\u001b[201~`,
      });
      expect(h.writes[1]).toEqual({ paneId: 'pane-1', data: '\r' });

      // The follow-up retry finds an empty queue and resets the activity state.
      await vi.advanceTimersByTimeAsync(3600);
      expect(h.state.coordinatorState).toBe('idle');
      expect(h.deliveries()).toBe(1); // never re-delivered
    });

    it('waits for the pane to go quiet before typing anything', async () => {
      const h = makeHarness();
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.writes).toHaveLength(0);

      // Fresh coordinator output restarts the quiet window.
      h.emitOutput();
      await vi.advanceTimersByTimeAsync(2500);
      expect(h.writes).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(700);
      expect(h.deliveries()).toBe(1);
      expect(h.writes).toHaveLength(2);
    });

    it('a full PTY input queue defers delivery instead of dropping', async () => {
      const h = makeHarness();
      h.setAccepted(false);
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      await vi.advanceTimersByTimeAsync(9500);

      expect(h.deliveries()).toBe(0);
      expect(h.state.pendingDigests).toEqual(['DIGEST-A']);
      expect(h.writes).toHaveLength(0);
      expect(h.attempts.length).toBeGreaterThanOrEqual(2); // retried after each quiet window

      // Drain the pane: the next retry lands the digest exactly once.
      h.setAccepted(true);
      await vi.advanceTimersByTimeAsync(3600);
      expect(h.deliveries()).toBe(1);
      expect(h.state.pendingDigests).toEqual([]);
      expect(h.writes.filter((w) => w.data.includes('DIGEST-A'))).toHaveLength(1);
    });

    it('leaves digests queued while the swarm is not running or the pane does not match', async () => {
      const h = makeHarness();
      h.state.running = false;
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      await vi.advanceTimersByTimeAsync(8000);

      expect(h.writes).toHaveLength(0);
      expect(h.deliveries()).toBe(0);
      expect(h.state.coordinatorState).toBe('idle'); // untouched by the early return

      h.state.running = true;
      h.state.coordinatorPaneId = 'pane-other';
      link.pump();
      await vi.advanceTimersByTimeAsync(8000);
      expect(h.writes).toHaveLength(0);

      // Watched pane matching the coordinator's pane lets delivery proceed.
      h.state.coordinatorPaneId = 'pane-1';
      link.pump();
      await vi.advanceTimersByTimeAsync(3600);
      expect(h.deliveries()).toBe(1);
    });

    it('an empty queue flips a digesting coordinator back to idle without writing', async () => {
      const h = makeHarness();
      h.state.pendingDigests = [];
      h.state.coordinatorState = 'digesting';
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      await vi.advanceTimersByTimeAsync(100);

      expect(h.state.coordinatorState).toBe('idle');
      expect(h.writes).toHaveLength(0);
    });

    it('a dropped Enter keystroke retries just the Enter, then counts as delivered', async () => {
      const h = makeHarness();
      let enterAttempts = 0;
      h.deps.writePty = async (paneId, data) => {
        if (data === '\r') {
          enterAttempts += 1;
          if (enterAttempts === 1) return { accepted: false };
        }
        h.writes.push({ paneId, data });
        return { accepted: true };
      };
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      // Tick (3.05s) + Enter gap (150ms) + the post-drop retry window (3s).
      await vi.advanceTimersByTimeAsync(6600);

      expect(h.deliveries()).toBe(1); // the whole digest was NOT duplicated
      expect(h.writes.filter((w) => w.data.includes('DIGEST-A'))).toHaveLength(1);
      expect(enterAttempts).toBe(2);
      expect(h.state.pendingDigests).toEqual([]);
    });

    it('a failed PTY write keeps the digest queued and logs the error', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const h = makeHarness();
        h.deps.writePty = async () => {
          throw new Error('pty gone');
        };
        const link = createCoordinatorLink(h.deps);
        link.watch('pane-1');

        link.pump();
        await vi.advanceTimersByTimeAsync(6600);

        expect(h.deliveries()).toBe(0);
        expect(h.state.pendingDigests).toEqual(['DIGEST-A']);
        expect(errSpy).toHaveBeenCalledWith(
          'Failed to inject digest into coordinator PTY:',
          expect.any(Error),
        );
      } finally {
        errSpy.mockRestore();
      }
    });

    it('stop and resetForTests cancel pending pump work; the pump re-arms afterwards', async () => {
      const h = makeHarness();
      const link = createCoordinatorLink(h.deps);
      link.watch('pane-1');

      link.pump();
      link.stop();
      await vi.advanceTimersByTimeAsync(8000);
      expect(h.attempts).toHaveLength(0);

      // stop() also dropped the watch; a later session re-arms it and delivery resumes.
      link.resetForTests();
      link.watch('pane-1');
      link.pump();
      await vi.advanceTimersByTimeAsync(3600);
      expect(h.deliveries()).toBe(1);
    });
  });
});
