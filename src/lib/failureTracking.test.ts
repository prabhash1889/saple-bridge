import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { recordFailure, resetFailureTracking } from './failureTracking';
import { useNotificationStore } from '../stores/notificationStore';

describe('recordFailure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetFailureTracking();
    useNotificationStore.getState().clearAll();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('surfaces a first failure as an auto-dismissing toast, not a sticky one', () => {
    recordFailure('state-save', 'Failed to save swarm state: disk full');
    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('warning');
    expect(notifications[0].persistent ?? false).toBe(false);
  });

  it('escalates to a sticky error after three repeats inside the window', () => {
    for (let i = 0; i < 3; i++) {
      recordFailure('pty-launch', 'Terminal failed to start');
      vi.advanceTimersByTime(5000);
    }
    const { notifications } = useNotificationStore.getState();
    // All three collapsed into one entry (store-level dedupe) that is now persistent.
    expect(notifications).toHaveLength(1);
    expect(notifications[0].persistent).toBe(true);
    expect(notifications[0].repeatCount).toBe(3);
  });

  it('stays non-persistent when the repeats fall outside the window', () => {
    for (let i = 0; i < 3; i++) {
      recordFailure('swarm-launch', 'Launch failed: provider missing');
      vi.advanceTimersByTime(61_000);
    }
    const { notifications } = useNotificationStore.getState();
    expect(notifications.every((n) => !n.persistent)).toBe(true);
  });

  it('forcePersistent escalates on the first occurrence', () => {
    recordFailure('control-plane', 'registerLaunch rejected', { forcePersistent: true });
    const { notifications } = useNotificationStore.getState();
    expect(notifications[0].persistent).toBe(true);
    expect(notifications[0].type).toBe('error');
  });

  it('keeps distinct failures in separate entries', () => {
    recordFailure('watcher', 'watch_project_files failed');
    recordFailure('state-save', 'tasks.json write failed');
    expect(useNotificationStore.getState().notifications).toHaveLength(2);
  });

  it('tracks windows per failure key independently', () => {
    recordFailure('watcher', 'watch failed');
    vi.advanceTimersByTime(10_000);
    recordFailure('watcher', 'a different watch failure');
    vi.advanceTimersByTime(10_000);
    recordFailure('watcher', 'watch failed'); // only its 2nd occurrence
    const { notifications } = useNotificationStore.getState();
    expect(notifications.every((n) => !n.persistent)).toBe(true);
  });
});
