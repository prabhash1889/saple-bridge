import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { useNotificationStore } from './notificationStore';

describe('notificationStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useNotificationStore.getState().clearAll();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caps the list at the newest 50 notifications', () => {
    const { error } = useNotificationStore.getState();
    for (let i = 1; i <= 60; i++) {
      error(`failure ${i}`); // persistent — never auto-dismissed
    }
    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(50);
    expect(notifications[0].message).toBe('failure 11');
    expect(notifications[49].message).toBe('failure 60');
  });

  it('removeNotification drops only the targeted entry', () => {
    const store = useNotificationStore.getState();
    const keep = store.info('keep me');
    const drop = store.info('drop me');
    useNotificationStore.getState().removeNotification(drop);
    const { notifications } = useNotificationStore.getState();
    expect(notifications.map((n) => n.id)).toEqual([keep]);
  });

  describe('dedupe', () => {
    it('collapses repeated identical toasts into one entry with a repeat count', () => {
      const store = useNotificationStore.getState();
      const first = store.warning('save failed', undefined, { category: 'state-save' });
      vi.advanceTimersByTime(1000);
      const second = store.warning('save failed', undefined, { category: 'state-save' });

      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].id).toBe(first);
      expect(second).toBe(first);
      expect(notifications[0].repeatCount).toBe(2);
    });

    it('does not dedupe messages that differ', () => {
      const store = useNotificationStore.getState();
      store.warning('save failed');
      store.warning('launch failed');
      expect(useNotificationStore.getState().notifications).toHaveLength(2);
    });

    it('stops collapsing once the dedupe window has passed', () => {
      const store = useNotificationStore.getState();
      store.info('transient hiccup');
      vi.advanceTimersByTime(5001);
      store.info('transient hiccup');
      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(2);
      expect(notifications.map((n) => n.repeatCount)).toEqual([1, 1]);
    });

    it('keeps a persistent root-cause error absorbing repeats at any age instead of going silent', () => {
      const store = useNotificationStore.getState();
      const id = store.error('swarm state cannot be written');
      vi.advanceTimersByTime(60_000);
      store.error('swarm state cannot be written');

      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].id).toBe(id);
      expect(notifications[0].repeatCount).toBe(2);
    });

    it('escalates a live auto-dismissing toast when a persistent variant of the same message lands', () => {
      const store = useNotificationStore.getState();
      const id = store.warning('watcher dropped', undefined, { category: 'watcher' });
      store.error('watcher dropped', undefined, { category: 'watcher' });

      const { notifications } = useNotificationStore.getState();
      expect(notifications).toHaveLength(1);
      expect(notifications[0].id).toBe(id);
      expect(notifications[0].persistent).toBe(true);
    });
  });
});
