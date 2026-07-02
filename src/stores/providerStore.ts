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
  // Signed in via the CLI's own subscription/OAuth login (independent of an API key). `null` =
  // unknown / no sign-in concept for this provider (e.g. openrouter, custom).
  signedIn: boolean | null;
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
  { provider: 'codex', label: 'Codex', cliCommand: 'codex --version', defaultModel: 'gpt-4o', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'claude', label: 'Claude', cliCommand: 'claude --version', defaultModel: 'claude-sonnet-4-20250514', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'gemini', label: 'Gemini', cliCommand: 'gemini --version', defaultModel: 'gemini-2.5-pro', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'openrouter', label: 'OpenRouter', cliCommand: '', defaultModel: 'openrouter/auto', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'opencode', label: 'OpenCode', cliCommand: 'opencode --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'cursor', label: 'Cursor', cliCommand: 'cursor-agent --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'droid', label: 'Droid', cliCommand: 'droid --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'copilot', label: 'Copilot', cliCommand: 'gh copilot --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'pi', label: 'Pi', cliCommand: 'pi --version', defaultModel: 'default', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
  { provider: 'custom', label: 'Custom', cliCommand: '', defaultModel: '', customModel: '', enabled: true, installed: null, version: null, authenticated: null, signedIn: null, error: null, checkedAt: null },
];

// Currency token: overlapping refreshes (e.g. settings open + a save triggering another pass)
// resolve in arbitrary order; only the latest may commit, or an older snapshot wins.
let refreshSeq = 0;

export const useProviderStore = create<ProviderState>()(
  (set, get) => ({
    providers: DEFAULT_PROVIDERS.map(p => ({ ...p })),
    testRunning: {},
    testResults: {},

    refreshReadiness: async () => {
      const requestId = ++refreshSeq;
      const providers = get().providers.map(async (p) => {
        // Providers with no dedicated CLI (openrouter is API-key/env only; custom is
        // user-supplied) skip CLI detection and report `installed: null` (N/A) so they aren't
        // counted as "missing".
        const hasCli = p.cliCommand.trim().length > 0;

        const [authed, cli, signedIn] = await Promise.all([
          checkKeychain(p.provider).catch(() => null as boolean | null),
          hasCli ? checkCli(p.provider) : Promise.resolve(null),
          checkSignin(p.provider),
        ]);

        return {
          ...p,
          authenticated: authed,
          installed: cli ? cli.available : null,
          version: cli?.version ?? null,
          signedIn,
          error: null,
          checkedAt: new Date().toISOString(),
        };
      });

      const resolved = await Promise.all(providers);
      if (requestId !== refreshSeq) return; // superseded by a newer refresh
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
        // A provider is reachable if it has either a stored API key OR an active CLI sign-in.
        // `test_provider_connection` reads the key internally in Rust and reports presence — it
        // never writes or returns the secret. (The old path wrote a sentinel value via
        // set_api_key, destroying the user's real provider key on every "Test" click.)
        const [keyPresent, signedIn] = await Promise.all([
          invoke<boolean>('test_provider_connection', { provider }),
          checkSignin(provider),
        ]);
        const ok = keyPresent || signedIn === true;
        set((state) => {
          const updatedProviders = state.providers.map((p) =>
            p.provider === provider ? { ...p, authenticated: keyPresent, signedIn, checkedAt: new Date().toISOString() } : p
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
      // Auth is "needed" only when neither an API key nor a CLI sign-in is present.
      return get().providers.filter(
        p => p.installed !== false && p.authenticated === false && p.signedIn !== true
      ).length;
    },

    getReadinessSummary: () => {
      const providers = get().providers.filter(p => p.enabled && p.provider !== 'custom');
      const parts: string[] = [];
      for (const p of providers) {
        const authed = p.authenticated === true || p.signedIn === true;
        if (p.installed === false) {
          parts.push(`${p.label} missing`);
        } else if (p.authenticated === false && p.signedIn !== true) {
          parts.push(`${p.label} auth needed`);
        } else if (p.installed === true && authed) {
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
      return (p.authenticated === true || p.signedIn === true) && p.enabled;
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

// Mirrors the Rust `CliStatus` returned by `check_provider_cli`.
interface CliStatus {
  name: string;
  available: boolean;
  version: string | null;
}

// Detect whether the provider's CLI is installed on PATH (and its version). Returns null if the
// command is unavailable so the store leaves `installed`/`version` unset rather than guessing.
async function checkCli(provider: AgentProvider): Promise<CliStatus | null> {
  try {
    return await invoke<CliStatus>('check_provider_cli', { provider });
  } catch {
    return null;
  }
}

// Detect whether the user is signed in via the provider CLI's own subscription/OAuth login
// (independent of an API key in our keychain). Returns null for providers with no sign-in concept
// or when the check is unavailable.
async function checkSignin(provider: AgentProvider): Promise<boolean | null> {
  try {
    return await invoke<boolean | null>('check_provider_signin', { provider });
  } catch {
    return null;
  }
}
