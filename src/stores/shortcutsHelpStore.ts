import { create } from 'zustand';

// Tiny open/close store for the Keyboard Shortcuts help dialog. Lets the command palette
// trigger it while the dialog itself is rendered once at the app root.
interface ShortcutsHelpState {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

export const useShortcutsHelpStore = create<ShortcutsHelpState>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
}));
