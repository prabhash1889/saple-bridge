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
  | 'grok'
  | 'custom';

// Provider facts (labels, ordering, model defaults/aliases, turn-injection and prompt-delivery
// capabilities, keychain naming, sign-in commands) live in `src/lib/providerFacts.ts`; the live
// per-provider readiness shape is owned by `ProviderEntry` in `src/stores/providerStore.ts`.
