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

// The live per-provider readiness shape (keychain auth + CLI install/version) is owned by the
// store: see `ProviderEntry` in `src/stores/providerStore.ts`.

// Swarm agents launch headless: the mission prompt is piped into the CLI, which runs in print
// mode with no terminal output until the process exits. Mirrors `provider_accepts_prompt_pipe`
// in `pty.rs` — GUI providers (cursor/copilot) and custom commands launch interactively instead.
// The distinction drives UI that tells a working headless pane apart from a hung one (P10).
export function isHeadlessProvider(provider?: AgentProvider): boolean {
  return provider !== 'cursor' && provider !== 'copilot' && provider !== 'custom';
}
