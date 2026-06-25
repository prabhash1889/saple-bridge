import React, { useEffect, useRef } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useConfirmStore } from '../../stores/confirmStore';

export const ConfirmDialog: React.FC = () => {
  const { isOpen, title, message, confirmLabel, cancelLabel, onConfirm, onCancel, close } = useConfirmStore();
  
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isOpen) {
      // Focus the cancel button (safer default)
      cancelBtnRef.current?.focus();

      // Listen for escape key and tab traps
      const handleKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          handleCancel();
        }
        if (e.key === 'Tab') {
          const focusables = dialogRef.current?.querySelectorAll('button');
          if (focusables && focusables.length >= 2) {
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              last.focus();
              e.preventDefault();
            } else if (!e.shiftKey && document.activeElement === last) {
              first.focus();
              e.preventDefault();
            }
          }
        }
      };

      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleConfirm = () => {
    if (onConfirm) onConfirm();
    close();
  };

  const handleCancel = () => {
    if (onCancel) onCancel();
    close();
  };

  return (
    <div className="modal-overlay confirm-overlay" onClick={handleCancel}>
      <div 
        ref={dialogRef}
        className="modal-container confirm-modal" 
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <div className="confirm-header">
          <div className="confirm-title-area">
            <AlertTriangle className="confirm-warning-icon" size={18} />
            <h3 id="confirm-title">{title}</h3>
          </div>
          <button className="confirm-close-x" onClick={handleCancel} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="confirm-body">
          <p>{message}</p>
        </div>
        <div className="confirm-footer">
          <button 
            ref={cancelBtnRef}
            className="btn btn-secondary confirm-cancel-btn" 
            onClick={handleCancel}
          >
            {cancelLabel}
          </button>
          <button 
            ref={confirmBtnRef}
            className="btn btn-danger confirm-ok-btn" 
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
