import { create } from 'zustand';
import { createId } from '../lib/id';

export type NotificationType = 'info' | 'success' | 'warning' | 'error';

export interface NotificationAction {
  label: string;
  onClick: () => void;
}

export interface AppNotification {
  id: string;
  type: NotificationType;
  message: string;
  description?: string;
  persistent?: boolean;
  duration?: number;
  action?: NotificationAction;
  createdAt: string;
  /**
   * Stable grouping key for dedupe (Phase 4). When omitted, `type + message` is used. Two
   * notifications sharing a key within the dedupe window collapse into one entry whose
   * `repeatCount` climbs instead of stacking identical toasts.
   */
  category?: string;
  /** How many times this notification (or its key) fired. 1 for a first occurrence. */
  repeatCount?: number;
}

interface NotificationState {
  notifications: AppNotification[];
  addNotification: (notification: Omit<AppNotification, 'id' | 'createdAt'>) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
  info: (message: string, description?: string, opts?: Partial<AppNotification>) => string;
  success: (message: string, description?: string, opts?: Partial<AppNotification>) => string;
  warning: (message: string, description?: string, opts?: Partial<AppNotification>) => string;
  error: (message: string, description?: string, opts?: Partial<AppNotification>) => string;
}

// Persistent notifications (errors) are never auto-dismissed, so without a cap a long session
// with a failing background poll accumulates entries without bound. Keep only the newest.
const MAX_NOTIFICATIONS = 50;

// Repeated identical notifications within this window collapse into one entry with a bumped
// repeat count. Short enough that unrelated later messages still get their own toast.
const DEDUPE_WINDOW_MS = 5000;

function dedupeKeyOf(n: Omit<AppNotification, 'id' | 'createdAt'>): string {
  // Categorized notifications dedupe across severities so an escalating repeat upgrades the
  // existing entry instead of stacking a second toast; uncategorized ones keep type in the key.
  return `${n.category ?? n.type}:${n.message}`;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  addNotification: (notification) => {
    const key = dedupeKeyOf(notification);
    const now = Date.now();
    let reusedId: string | null = null;

    set((state) => {
      // Newest match wins; scan backwards because repeat storms append at the tail.
      for (let i = state.notifications.length - 1; i >= 0; i--) {
        const existing = state.notifications[i];
        if (dedupeKeyOf(existing) !== key) continue;
        const withinWindow =
          now - new Date(existing.createdAt).getTime() <= DEDUPE_WINDOW_MS ||
          Boolean(existing.persistent);
        // An incoming persistent error upgrades a stale matching toast too: escalation must take
        // over the entry rather than stack a second one next to it.
        const escalatesStale = !withinWindow && notification.persistent === true;
        // A persistent root-cause error is never deduped away into silence: an existing sticky
        // entry absorbs repeats at any age (bumping its count), while auto-dismissing toasts only
        // collapse inside the window.
        if (!withinWindow && !escalatesStale) break;

        const updated: AppNotification = {
          ...existing,
          ...notification,
          id: existing.id,
          // Refresh visibility on a stale takeover so the sticky entry reads as current.
          createdAt: escalatesStale ? new Date(now).toISOString() : existing.createdAt,
          persistent: existing.persistent || notification.persistent === true,
          repeatCount: (existing.repeatCount ?? 1) + 1,
        };
        reusedId = updated.id;
        const next = [...state.notifications];
        next[i] = updated;
        return { notifications: next.slice(-MAX_NOTIFICATIONS) };
      }

      const id = createId('notif');
      reusedId = id;
      const newNotification: AppNotification = {
        ...notification,
        id,
        createdAt: new Date().toISOString(),
        repeatCount: 1,
      };
      return { notifications: [...state.notifications, newNotification].slice(-MAX_NOTIFICATIONS) };
    });

    return reusedId ?? createId('notif');
  },
  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },
  clearAll: () => {
    set({ notifications: [] });
  },
  info: (message, description, opts) => {
    return get().addNotification({
      type: 'info',
      message,
      description,
      duration: 4000,
      ...opts,
    });
  },
  success: (message, description, opts) => {
    return get().addNotification({
      type: 'success',
      message,
      description,
      duration: 4000,
      ...opts,
    });
  },
  warning: (message, description, opts) => {
    return get().addNotification({
      type: 'warning',
      message,
      description,
      duration: 6000,
      ...opts,
    });
  },
  error: (message, description, opts) => {
    return get().addNotification({
      type: 'error',
      message,
      description,
      persistent: true,
      ...opts,
    });
  },
}));
