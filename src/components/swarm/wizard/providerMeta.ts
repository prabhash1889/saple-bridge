import type { AgentProvider } from '../../../types/provider';

// Single source of truth for provider UI. Reused by the wizard Roster chips,
// the "CLI agent for all" selector, and the SwarmTemplateEditor dropdown.

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  droid: 'Droid',
  copilot: 'Copilot',
  pi: 'Pi',
  custom: 'Custom',
};

// Display order for the CLI-agent chip rows (wizard "CLI Agent for All" + per-agent picker).
// Lists every provider that launches as a real CLI in `spawn_pty` (see the mapping in
// `src-tauri/src/pty.rs`). `openrouter` is intentionally omitted — it has no CLI binary (API-key/
// env only), so it must not be selectable as a swarm agent. `custom` is appended where needed.
export const PROVIDER_ORDER: AgentProvider[] = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'cursor',
  'droid',
  'copilot',
  'pi',
];

// GUI-oriented agents that don't accept a piped prompt file; the Rust PTY layer
// launches them interactively. Surfaced with an "experimental" badge in the UI.
export const EXPERIMENTAL_PROVIDERS = new Set<AgentProvider>(['cursor', 'copilot']);

// Default model per provider, used when generating a roster or switching CLI.
export const PROVIDER_DEFAULT_MODEL: Record<AgentProvider, string> = {
  claude: 'claude-sonnet-4-20250514',
  codex: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  openrouter: 'openrouter/auto',
  opencode: 'default',
  cursor: 'default',
  droid: 'default',
  copilot: 'default',
  pi: 'default',
  custom: 'default',
};
