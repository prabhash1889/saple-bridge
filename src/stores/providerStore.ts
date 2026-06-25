import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { AgentProvider } from '../types/provider';

interface ProviderEntry {
  provider: AgentProvider;
  label: string;
  cliCommand: string;
  defaultModel: string;
  customModel: string;
  enabled: boolean;
  installed: boolean | null;
  version: string | null;
  authenticated: boolean | null;
  error: string | null;
  checkedAt: string | null;
}

interface ProviderState {
  providers: ProviderEntry[];
  testRunning: Record<string, boolean>;
  testResults: Record<string, 'success' | 'error' | null>;

  refreshReadiness: () => Promise<void>;
  setCustomModel: (provider: AgentProvider, model: string) => Promise<void>;
  setEnabled: (provider: AgentProvider, enabled: boolean) => Promise<void>;
  testProvider: (provider: AgentProvider) => Promise<void>;
  getInstalledCount: () => number;
  getMissingCount: () => number;
  getAuthNeededCount: () => number;
  getReadinessSummary: () => string;
  isReady: (provider: AgentProvider) => boolean;
}

const KEYCHAIN_SERVICE_PREFIX = 'saple_provider_';

function keychainService(provider: AgentProvider): string {
  return `${KEYCHAIN_SERVICE_PREFIX}${provider}_api_key`;
}

const DEFAULT_PROVIDERS: ProviderEntry[] = [
  { provider: 'bridgecode', label: 'BridgeCode', cliCommand: 'bridgecode --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'codex', label: 'Codex', cliCommand: 'codex --version', defaultModel: 'gpt-4o', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'claude', label: 'Claude', cliCommand: 'claude --version', defaultModel: 'claude-sonnet-4-20250514', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'gemini', label: 'Gemini', cliCommand: 'gemini --version', defaultModel: 'gemini-2.5-pro', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'opencode', label: 'OpenCode', cliCommand: 'opencode --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'cursor', label: 'Cursor', cliCommand: 'cursor-agent --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'droid', label: 'Droid', cliCommand: 'droid --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'copilot', label: 'Copilot', cliCommand: 'gh copilot --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'pi', label: 'Pi', cliCommand: 'pi --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
  { provider: 'custom', label: 'Custom', cliCommand: '', defaultModel: '', customModel: '', enabled: true, installed: null, version: null, authenticated: null, error: null, checkedAt: null },
];

export const useProviderStore = create<ProviderState>()(
  (set, get) => ({
    providers: DEFAULT_PROVIDERS.map(p => ({ ...p })),
    testRunning: {},
    testResults: {},

    refreshReadiness: async () => {
      const providers = get().providers.map(async (p) => {
        if (p.provider === 'custom') {
          const authed = await checkKeychain(p.provider);
          return { ...p, authenticated: authed, checkedAt: new Date().toISOString() };
        }

        let authed: boolean | null = null;
        let error: string | null = null;

        try {
          authed = await checkKeychain(p.provider);
        } catch (e) {
          error = String(e);
        }

        return {
          ...p,
          authenticated: authed,
          error,
          checkedAt: new Date().toISOString(),
        };
      });

      const resolved = await Promise.all(providers);
      set({ providers: resolved });
    },

    setCustomModel: async (provider, model) => {
      set((state) => ({
        providers: state.providers.map((p) =>
          p.provider === provider ? { ...p, customModel: model } : p
        ),
      }));
    },

    setEnabled: async (provider, enabled) => {
      set((state) => ({
        providers: state.providers.map((p) =>
          p.provider === provider ? { ...p, enabled } : p
        ),
      }));
    },

    testProvider: async (provider) => {
      set((state) => ({
        testRunning: { ...state.testRunning, [provider]: true },
        testResults: { ...state.testResults, [provider]: null },
      }));

      try {
        // Reads the stored key internally in Rust and reports presence — it never writes to or
        // returns the secret. (The old path wrote a sentinel value via set_api_key, destroying the
        // user's real provider key on every "Test" click.)
        const ok = await invoke<boolean>('test_provider_connection', { provider });
        set((state) => {
          const updatedProviders = state.providers.map((p) =>
            p.provider === provider ? { ...p, authenticated: ok ? (true as boolean | null) : (false as boolean | null), checkedAt: new Date().toISOString() } : p
          );
          return {
            testRunning: { ...state.testRunning, [provider]: false },
            testResults: { ...state.testResults, [provider]: ok ? 'success' as const : 'error' as const },
            providers: updatedProviders,
          };
        });
      } catch {
        set((state) => {
          const updatedProviders = state.providers.map((p) =>
            p.provider === provider ? { ...p, authenticated: false as boolean | null, checkedAt: new Date().toISOString() } : p
          );
          return {
            testRunning: { ...state.testRunning, [provider]: false },
            testResults: { ...state.testResults, [provider]: 'error' as const },
            providers: updatedProviders,
          };
        });
      }
    },

    getInstalledCount: () => {
      return get().providers.filter(p => p.installed === true).length;
    },

    getMissingCount: () => {
      return get().providers.filter(p => p.installed === false).length;
    },

    getAuthNeededCount: () => {
      return get().providers.filter(p => p.installed !== false && p.authenticated === false).length;
    },

    getReadinessSummary: () => {
      const providers = get().providers.filter(p => p.enabled && p.provider !== 'custom');
      const parts: string[] = [];
      for (const p of providers) {
        if (p.installed === false) {
          parts.push(`${p.label} missing`);
        } else if (p.authenticated === false) {
          parts.push(`${p.label} auth needed`);
        } else if (p.installed === true && p.authenticated === true) {
          parts.push(`${p.label} ready`);
        } else {
          parts.push(`${p.label} checking...`);
        }
      }
      return parts.join(', ');
    },

    isReady: (provider) => {
      const p = get().providers.find(p => p.provider === provider);
      if (!p) return false;
      if (provider === 'custom') return p.enabled;
      return p.authenticated === true && p.enabled;
    },
  })
);

async function checkKeychain(provider: AgentProvider): Promise<boolean> {
  try {
    // Presence check only — the secret never crosses the IPC boundary.
    return await invoke<boolean>('has_api_key', {
      service: keychainService(provider),
    });
  } catch {
    return false;
  }
}
