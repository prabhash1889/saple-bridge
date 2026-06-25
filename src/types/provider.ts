export type AgentProvider =
  | 'bridgecode'
  | 'codex'
  | 'claude'
  | 'gemini'
  | 'opencode'
  | 'cursor'
  | 'droid'
  | 'copilot'
  | 'pi'
  | 'custom';

export interface ProviderConfig {
  provider: AgentProvider;
  label: string;
  cliCommand: string;
  defaultModel: string;
  customModel?: string;
  enabled: boolean;
}

export interface ProviderReadiness {
  provider: AgentProvider;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  accountProfile?: string;
  error?: string;
  checkedAt: string;
}
