import { providerKeychainService } from '../../../lib/providerFacts';

// The Keychain tab's "OpenAI API Key (for Codex)" slot writes the SAME keychain entry the Codex
// provider card uses (`saple_provider_codex_api_key`), so a key saved in either place reflects in
// both. Previously this tab used the legacy `openai_api_key` service, which silently diverged from
// the provider cards.
export const CODEX_KEY_SERVICE = providerKeychainService('codex');

export const MASKED_KEY = '•'.repeat(32);
