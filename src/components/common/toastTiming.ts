import type { AppNotification } from '../../stores/notificationStore';

/**
 * Auto-dismiss delay for a toast, or null when it must stay until manually closed.
 * Actionable toasts are kept persistent: an auto-dismissing button would regularly
 * vanish before the user could reach it.
 */
export function autoDismissDelay(
  notification: Pick<AppNotification, 'persistent' | 'duration' | 'action'>,
): number | null {
  if (notification.persistent || notification.action) return null;
  return notification.duration ?? 4000;
}

export type DismissStatus = 'idle' | 'running' | 'paused';

export interface DismissScheduler {
  start: (delayMs: number) => void;
  /** Stop the countdown, remembering the remaining time for resume(). */
  pause: () => void;
  /** Continue the countdown from where pause() left off. */
  resume: () => void;
  cancel: () => void;
  readonly status: DismissStatus;
}

/**
 * Timeout-based countdown that supports pause/resume by tracking elapsed time.
 * Used by ToastHost so hovering or focusing a toast freezes its auto-dismiss.
 */
export function createDismissScheduler(onExpire: () => void): DismissScheduler {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let startedAt: number | null = null;
  let remainingMs = 0;

  const fire = () => {
    timeoutId = null;
    startedAt = null;
    remainingMs = 0;
    onExpire();
  };

  const arm = (delayMs: number) => {
    timeoutId = setTimeout(fire, delayMs);
    startedAt = Date.now();
  };

  return {
    start(delayMs) {
      this.cancel();
      remainingMs = delayMs;
      arm(remainingMs);
    },
    pause() {
      if (timeoutId === null || startedAt === null) return;
      clearTimeout(timeoutId);
      timeoutId = null;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
      startedAt = null;
    },
    resume() {
      if (timeoutId !== null) return;
      arm(remainingMs);
    },
    cancel() {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
      startedAt = null;
      remainingMs = 0;
    },
    get status(): DismissStatus {
      if (timeoutId !== null) return 'running';
      // A paused countdown always has its remaining time banked; idle means
      // nothing armed (never started, expired, or cancelled).
      return startedAt === null && remainingMs > 0 ? 'paused' : 'idle';
    },
  };
}
