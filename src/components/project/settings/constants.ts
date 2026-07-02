export const KEYCHAIN_SERVICE_PREFIX = 'saple_provider_';

// The Keychain tab's "OpenAI API Key (for Codex)" slot writes the SAME keychain entry the Codex
// provider card uses (`saple_provider_codex_api_key`), so a key saved in either place reflects in
// both. Previously this tab used the legacy `openai_api_key` service, which silently diverged from
// the provider cards.
export const CODEX_KEY_SERVICE = `${KEYCHAIN_SERVICE_PREFIX}codex_api_key`;

// Providers that support subscription "Sign In" via their CLI's interactive login,
// instead of (or in addition to) an API key. The value is the command launched in a
// terminal pane so the user can complete the browser/OAuth flow with their paid plan.
export const SIGN_IN_COMMANDS: Partial<Record<string, string>> = {
  claude: 'claude',
  codex: 'codex login',
};

export const MASKED_KEY = '•'.repeat(32);
