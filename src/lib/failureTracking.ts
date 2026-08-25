// Persistent-failure surfacing and escalation (Phase 4 observability).
//
// Background failures (state saves, control-plane writes, watchers, PTY launch, swarm launch)
// used to die as console.error lines at best. This tracker gives them one policy:
//
//   - Every occurrence is forwarded to the durable log via reportError.
//   - First occurrences surface as an ordinary auto-dismissing toast, deduped by
//     notificationStore (same category + message collapses into one toast with a repeat count).
//   - Once a failure repeats PERSISTENT_THRESHOLD times inside WINDOW_MS - or the caller marks it
//     forcePersistent up front - it escalates to a sticky error notification that survives until
//     the user dismisses it. Repeats after escalation keep bumping that same sticky entry instead
//     of stacking toasts.

import { useNotificationStore } from '../stores/notificationStore';
import { reportError } from './errorReporting';

const PERSISTENT_THRESHOLD = 3;
const WINDOW_MS = 60_000;

export interface FailureOptions {
  /** Extra detail shown under the toast message. */
  description?: string;
  /** Escalate immediately regardless of repeat count (caller knows this is a hard failure). */
  forcePersistent?: boolean;
}

// key -> occurrence timestamps (ms), oldest last.
const occurrences = new Map<string, number[]>();

function now(): number {
  return Date.now();
}

/**
 * Record one failure of a given category ("state-save", "control-plane", "watcher",
 * "pty-launch", "swarm-launch", ...). Never throws.
 */
export function recordFailure(category: string, message: string, opts: FailureOptions = {}): void {
  try {
    reportError(message, category);

    const key = `${category}:${message}`;
    const stamps = occurrences.get(key) ?? [];
    const t = now();
    while (stamps.length > 0 && t - stamps[0] > WINDOW_MS) {
      stamps.shift();
    }
    stamps.push(t);
    occurrences.set(key, stamps);

    const persistent = opts.forcePersistent === true || stamps.length >= PERSISTENT_THRESHOLD;
    if (persistent) {
      // The close button on a persistent notification is its dismiss action; repeats land here
      // too and just bump the existing entry's repeat count via store-level dedupe.
      useNotificationStore.getState().error(message, opts.description, { category });
    } else {
      useNotificationStore.getState().warning(message, opts.description, { category });
    }
  } catch {
    // Surfacing must never break the failing operation that reported.
  }
}

/** Drop all tracked occurrence history. Test seam; also useful after a project switch. */
export function resetFailureTracking(): void {
  occurrences.clear();
}
