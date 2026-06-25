import type { AgentProvider } from '../../../types/provider';

// Single source of truth for provider UI. Reused by the wizard Roster chips,
// the "CLI agent for all" selector, and the SwarmTemplateEditor dropdown.

export const PROVIDER_LABELS: Record<AgentProvider, string> = {
  bridgecode: 'BridgeCode',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  droid: 'Droid',
  copilot: 'Copilot',
  pi: 'Pi',
  custom: 'Custom',
};

// Display order for the primary CLI-agent chip row (matches the design mockups).
export const PROVIDER_ORDER: AgentProvider[] = [
  'claude',
  'codex',
  'opencode',
];

// GUI-oriented agents that don't accept a piped prompt file; the Rust PTY layer
// launches them interactively. Surfaced with an "experimental" badge in the UI.
export const EXPERIMENTAL_PROVIDERS = new Set<AgentProvider>(['cursor', 'copilot']);

// Default model per provider, used when generating a roster or switching CLI.
export const PROVIDER_DEFAULT_MODEL: Record<AgentProvider, string> = {
  bridgecode: 'default',
  claude: 'claude-sonnet-4-20250514',
  codex: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  opencode: 'default',
  cursor: 'default',
  droid: 'default',
  copilot: 'default',
  pi: 'default',
  custom: 'default',
};
