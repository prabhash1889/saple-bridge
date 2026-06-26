export type AgentProvider =
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'openrouter'
  | 'opencode'
  | 'cursor'
  | 'droid'
  | 'copilot'
  | 'pi'
  | 'custom';

// The live per-provider readiness shape (keychain auth + CLI install/version) is owned by the
// store: see `ProviderEntry` in `src/stores/providerStore.ts`.
