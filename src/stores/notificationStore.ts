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

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  addNotification: (notification) => {
    const id = createId('notif');
    const newNotification: AppNotification = {
      ...notification,
      id,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));
    return id;
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
