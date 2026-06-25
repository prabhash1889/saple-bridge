import React, { useEffect } from 'react';
import { X, CheckCircle, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { useNotificationStore, AppNotification } from '../../stores/notificationStore';

export const ToastHost: React.FC = () => {
  const { notifications, removeNotification } = useNotificationStore();

  return (
    <div className="toast-container" aria-live="assertive">
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

  useEffect(() => {
    if (persistent) return;
    const time = duration || 4000;
    const timer = setTimeout(() => {
      onClose(id);
    }, time);

    return () => clearTimeout(timer);
  }, [id, persistent, duration, onClose]);

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

  return (
    <div className={`toast-item toast-${type}`}>
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
