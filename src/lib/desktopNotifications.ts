import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import { useNotificationStore, type NotificationType } from '../stores/notificationStore';

interface AppNotificationOptions {
  title: string;
  body?: string;
  toastType?: NotificationType;
}

const toast = ({ title, body, toastType = 'info' }: AppNotificationOptions) => {
  const store = useNotificationStore.getState();
  store[toastType](title, body);
};

export const notifyWhenUnfocused = async (options: AppNotificationOptions) => {
  if (typeof document !== 'undefined' && document.hasFocus()) {
    toast(options);
    return;
  }

  try {
    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      permissionGranted = (await requestPermission()) === 'granted';
    }

    if (permissionGranted) {
      sendNotification({
        title: options.title,
        body: options.body,
      });
      return;
    }
  } catch (err) {
    console.warn('Failed to send OS notification:', err);
  }

  toast(options);
};

export const notifyAgentStatusChanged = (
  agentName: string,
  status: 'done' | 'failed',
) => {
  void notifyWhenUnfocused({
    title: status === 'done' ? 'Agent finished' : 'Agent failed',
    body: agentName,
    toastType: status === 'done' ? 'success' : 'error',
  });
};

export const notifyTaskReadyForReview = (taskTitle: string) => {
  void notifyWhenUnfocused({
    title: 'Task ready for review',
    body: taskTitle,
    toastType: 'warning',
  });
};
