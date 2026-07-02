import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from './notificationStore';

describe('notificationStore', () => {
  beforeEach(() => {
    useNotificationStore.getState().clearAll();
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
});
