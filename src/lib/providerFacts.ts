import type { AgentProvider } from '../types/provider';

// Single source of truth for AI-provider facts on the renderer side. The privileged side has
// its own owner across the IPC boundary (`src-tauri/src/providers.rs`): launch commands,
// readiness probes, keychain services and credential env vars are defined THERE; this module
// holds what the UI needs - labels/ordering, model defaults and aliases, turn-injection and
// prompt-delivery capabilities, the keychain naming convention it passes back over IPC, and
// the readiness/sign-in display strings. Keep the two sides consistent when adding a provider.

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
  grok: 'Grok',
  custom: 'Custom',
};

// Display order for the CLI-agent chip rows (wizard "CLI Agent for All" + per-agent picker).
// Lists every provider that launches as a real CLI in `spawn_pty` (see `providers.rs`).
// `openrouter` is intentionally omitted - it has no CLI binary (API-key/env only), so it must
// not be selectable as a swarm agent. `custom` is appended where needed.
export const PROVIDER_ORDER: AgentProvider[] = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'cursor',
  'droid',
  'copilot',
  'pi',
  'grok',
];

// GUI-oriented agents that don't accept a piped prompt file; the Rust PTY layer
// launches them interactively. Surfaced with an "experimental" badge in the UI.
export const EXPERIMENTAL_PROVIDERS = new Set<AgentProvider>(['cursor', 'copilot']);

// Phase 3: providers whose interactive TUI reliably accepts an injected typed turn (bracketed
// paste + Enter written straight to the PTY). Coordinators on these run LIVE for the whole swarm
// and receive results digests in their own session; every other provider uses the digest-relaunch
// fallback - injection is the optimization, relaunch is the guarantee. Conservative on purpose:
// add a provider here only once its TUI is verified to accept injected turns.
export const TURN_INJECTION_PROVIDERS = new Set<AgentProvider>(['claude', 'codex', 'gemini', 'opencode']);

export const providerSupportsTurnInjection = (provider?: AgentProvider): boolean =>
  !!provider && TURN_INJECTION_PROVIDERS.has(provider);

// Default model per provider, used when generating a roster or switching CLI.
//
// `'default'` means "let the CLI pick its own current model": spawn_pty omits the `--model` flag
// for `'default'`/empty (see pty.rs `use_model_flag`), so the agent always launches on whatever
// its CLI ships as current. That is deliberately preferred over pinning a version-stamped id here,
// which silently rots as providers release new models. A concrete id belongs only in a user's
// explicit per-agent override. `openrouter/auto` is a routing directive (auto-selects a model),
// not a pinned version, so it stays - and openrouter has no CLI, so it never actually launches.
export const PROVIDER_DEFAULT_MODEL: Record<AgentProvider, string> = {
  claude: 'default',
  codex: 'default',
  gemini: 'default',
  openrouter: 'openrouter/auto',
  opencode: 'default',
  cursor: 'default',
  droid: 'default',
  copilot: 'default',
  pi: 'default',
  grok: 'default',
  custom: 'default',
};

// Stable, non-rotting CLI aliases per provider - the always-offline first layer of the model
// combobox (P8). Only aliases the CLI documents as durable belong here; version-pinned ids rot and
// live in the API-discovery layer or recents instead. `default`/`openrouter/auto` mean "let the CLI
// pick" (spawn_pty omits `--model`) and stay first so the safe choice is preselected.
export const PROVIDER_MODEL_ALIASES: Record<AgentProvider, string[]> = {
  // Claude Code's documented model aliases; they track each tier's current model without pinning.
  claude: ['default', 'sonnet', 'opus', 'haiku'],
  codex: ['default'],
  gemini: ['default'],
  openrouter: ['openrouter/auto'],
  opencode: ['default'],
  cursor: ['default'],
  droid: ['default'],
  copilot: ['default'],
  pi: ['default'],
  grok: ['default'],
  custom: ['default'],
};

// Keychain namespace every provider credential slot follows. Must match the validator in
// `src-tauri/src/keychain.rs`, which refuses any service outside `<PREFIX><id><SUFFIX>`.
export const KEYCHAIN_SERVICE_PREFIX = 'saple_provider_';
export const KEYCHAIN_SERVICE_SUFFIX = '_api_key';

export function providerKeychainService(provider: AgentProvider): string {
  return `${KEYCHAIN_SERVICE_PREFIX}${provider}${KEYCHAIN_SERVICE_SUFFIX}`;
}

// Readiness display command per provider ('' = no dedicated CLI: openrouter is API-key/env
// only, custom is user-supplied). Mirrors the probe table in `src-tauri/src/providers.rs`,
// which owns the actual detection; this drives the Settings card copy and whether the store
// runs a CLI check at all.
export const PROVIDER_CLI_COMMAND: Record<AgentProvider, string> = {
  claude: 'claude --version',
  codex: 'codex --version',
  gemini: 'gemini --version',
  openrouter: '',
  opencode: 'opencode --version',
  cursor: 'cursor-agent --version',
  droid: 'droid --version',
  copilot: 'gh copilot --version',
  pi: 'pi --version',
  grok: 'grok --version',
  custom: '',
};

// Providers that support subscription "Sign In" via their CLI's interactive login,
// instead of (or in addition to) an API key. The value is the command launched in a
// terminal pane so the user can complete the browser/OAuth flow with their paid plan.
export const SIGN_IN_COMMANDS: Partial<Record<AgentProvider, string>> = {
  claude: 'claude',
  codex: 'codex login',
};

// Swarm agents launch headless: the mission prompt is piped into the CLI, which runs in print
// mode with no terminal output until the process exits. Mirrors `accepts_prompt_pipe` in
// `src-tauri/src/providers.rs` - GUI providers (cursor/copilot) and custom commands launch
// interactively instead. The distinction drives UI that tells a working headless pane apart
// from a hung one (P10).
export function isHeadlessProvider(provider?: AgentProvider): boolean {
  return provider !== 'cursor' && provider !== 'copilot' && provider !== 'custom';
}
