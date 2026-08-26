import React, { useEffect, useRef, useState } from 'react';
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { useNotificationStore, AppNotification } from '../../stores/notificationStore';
import { autoDismissDelay, createDismissScheduler } from './toastTiming';

export const ToastHost: React.FC = () => {
  const { notifications, removeNotification } = useNotificationStore();

  return (
    <div className="toast-container">
      {notifications.map((notif: AppNotification) => (
        <ToastItem key={notif.id} notification={notif} onClose={removeNotification} />
      ))}
    </div>
  );
};

interface ToastItemProps {
  notification: AppNotification;
  onClose: (id: string) => void;
}

const ToastItem: React.FC<ToastItemProps> = ({ notification, onClose }) => {
  const { id, type, message, description, persistent, duration, action } = notification;

  // Hovering or keyboard-focusing a toast freezes its auto-dismiss countdown.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const delay = autoDismissDelay({ persistent, duration, action });
  const schedulerRef = useRef(createDismissScheduler(() => onClose(id)));

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (delay === null) {
      scheduler.cancel();
      return;
    }
    scheduler.start(delay);
    if (hovered || focused) scheduler.pause();
    return () => scheduler.cancel();
    // Hover state is intentionally excluded here; the effect below handles pause/resume
    // so hovering does not restart the countdown from full.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, delay]);

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (hovered || focused) {
      scheduler.pause();
    } else if (scheduler.status === 'paused') {
      scheduler.resume();
    }
  }, [hovered, focused]);

  const getIcon = () => {
    switch (type) {
      case 'success':
        return <CheckCircle className="toast-icon success" size={16} />;
      case 'warning':
        return <AlertTriangle className="toast-icon warning" size={16} />;
      case 'error':
        return <AlertCircle className="toast-icon error" size={16} />;
      case 'info':
      default:
        return <Info className="toast-icon info" size={16} />;
    }
  };

  // Errors announce assertively (role=alert); everything else stays polite.
  const announcementRole = type === 'error' ? 'alert' : 'status';

  return (
    <div
      className={`toast-item toast-${type}`}
      role={announcementRole}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={() => setFocused(false)}
    >
      <div className="toast-body">
        {getIcon()}
        <div className="toast-content">
          <span className="toast-message">{message}</span>
          {description && <p className="toast-description">{description}</p>}
          {action && (
            <button
              className="toast-action-btn"
              onClick={() => {
                action.onClick();
                onClose(id);
              }}
            >
              {action.label}
            </button>
          )}
        </div>
      </div>
      <button className="toast-close-btn" onClick={() => onClose(id)} aria-label="Close notification">
        <X size={14} />
      </button>
    </div>
  );
};
