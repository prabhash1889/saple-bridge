import { create } from 'zustand';

interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: (() => void) | null;
  onCancel: (() => void) | null;
  confirm: (opts: ConfirmOpts) => void;
  close: () => void;
}

export const useConfirmStore = create<ConfirmState>((set) => ({
  isOpen: false,
  title: 'Confirm Action',
  message: 'Are you sure you want to proceed?',
  confirmLabel: 'Confirm',
  cancelLabel: 'Cancel',
  onConfirm: null,
  onCancel: null,
  confirm: (opts) => {
    set({
      isOpen: true,
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel: opts.cancelLabel || 'Cancel',
      onConfirm: opts.onConfirm,
      onCancel: opts.onCancel || null,
    });
  },
  close: () => {
    set({
      isOpen: false,
      onConfirm: null,
      onCancel: null,
    });
  },
}));
