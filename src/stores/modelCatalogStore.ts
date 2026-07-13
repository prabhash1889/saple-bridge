import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProvider } from '../types/provider';
import { PROVIDER_MODEL_ALIASES } from '../components/swarm/wizard/providerMeta';

// Per-provider model catalog feeding the model comboboxes (P8). Three layers, most-trusted first:
//   1. Stable CLI aliases (static, always available — see PROVIDER_MODEL_ALIASES).
//   2. Recently-used models (persisted here, survive restart).
//   3. Live API discovery via the Rust `list_provider_models` command (session cache; empty when no
//      keychain key or offline).
// `is_safe_model` in pty.rs stays the launch gate; this only populates suggestions.

const RECENTS_LIMIT = 8;

interface ModelCatalogState {
  // Persisted: models the user has actually launched, newest first, per provider.
  recents: Partial<Record<AgentProvider, string[]>>;
  // Session-only: ids returned by API discovery. Not persisted — the server list is the source of
  // truth and changes, so we re-fetch each session rather than resurrect a stale cache.
  apiModels: Partial<Record<AgentProvider, string[]>>;
  // Providers we've already kicked off discovery for this session (fetch once, in-flight included).
  fetched: Partial<Record<AgentProvider, boolean>>;
  recordUsed: (provider: AgentProvider, model: string) => void;
  ensureApiModels: (provider: AgentProvider) => void;
}

export const useModelCatalogStore = create<ModelCatalogState>()(
  persist(
    (set, get) => ({
      recents: {},
      apiModels: {},
      fetched: {},

      recordUsed: (provider, model) => {
        const trimmed = model.trim();
        // 'default'/'openrouter/auto' are aliases already shown first; don't clutter recents with them.
        if (!trimmed || trimmed === 'default' || PROVIDER_MODEL_ALIASES[provider]?.includes(trimmed)) return;
        set((state) => {
          const prev = state.recents[provider] ?? [];
          const next = [trimmed, ...prev.filter((m) => m !== trimmed)].slice(0, RECENTS_LIMIT);
          return { recents: { ...state.recents, [provider]: next } };
        });
      },

      ensureApiModels: (provider) => {
        if (get().fetched[provider]) return;
        set((state) => ({ fetched: { ...state.fetched, [provider]: true } }));
        invoke<string[]>('list_provider_models', { provider })
          .then((ids) => {
            if (ids.length) set((state) => ({ apiModels: { ...state.apiModels, [provider]: ids } }));
          })
          .catch(() => {
            // Discovery is best-effort; on error we simply keep aliases + recents. Allow a retry
            // next session by leaving the persisted layers untouched.
          });
      },
    }),
    {
      name: 'saple-bridge-model-catalog-store',
      // Only recents are durable; API cache and fetch flags are per-session.
      partialize: (state) => ({ recents: state.recents }),
    }
  )
);

/** Assemble the deduped, ordered option list for a provider: aliases, then recents, then API ids. */
export function assembleModelCatalog(
  provider: AgentProvider,
  recents: string[] = [],
  apiModels: string[] = []
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of [...(PROVIDER_MODEL_ALIASES[provider] ?? ['default']), ...recents, ...apiModels]) {
    if (m && !seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}
