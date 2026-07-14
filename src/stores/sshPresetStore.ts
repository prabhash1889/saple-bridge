import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createId } from '../lib/id';
import type { SshPreset } from '../lib/sshPreset';

export type { SshPreset } from '../lib/sshPreset';

interface SshPresetState {
  presets: SshPreset[];
  addPreset: (preset: Omit<SshPreset, 'id'>) => void;
  updatePreset: (id: string, updates: Partial<Omit<SshPreset, 'id'>>) => void;
  removePreset: (id: string) => void;
}

// SSH presets are user-level connection configs (host aliases), not project state — persisted to
// localStorage like the theme/font prefs. Only the alias, remote dir, and provider command are
// stored; passwords and private keys are never a field, so nothing sensitive is written (P7).
export const useSshPresetStore = create<SshPresetState>()(
  persist(
    (set) => ({
      presets: [],
      addPreset: (preset) =>
        set((state) => ({ presets: [...state.presets, { ...preset, id: createId('ssh') }] })),
      updatePreset: (id, updates) =>
        set((state) => ({
          presets: state.presets.map((p) => (p.id === id ? { ...p, ...updates } : p)),
        })),
      removePreset: (id) =>
        set((state) => ({ presets: state.presets.filter((p) => p.id !== id) })),
    }),
    {
      name: 'saple-bridge-ssh-presets',
    },
  ),
);
