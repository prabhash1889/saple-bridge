import { describe, it, expect } from 'vitest';
import {
  isHeadlessProvider,
  providerKeychainService,
  PROVIDER_CLI_COMMAND,
  PROVIDER_DEFAULT_MODEL,
  PROVIDER_LABELS,
  SIGN_IN_COMMANDS,
} from './providerFacts';
import type { AgentProvider } from '../types/provider';

describe('isHeadlessProvider', () => {
  it('treats piped-prompt CLIs as headless', () => {
    expect(isHeadlessProvider('claude')).toBe(true);
    expect(isHeadlessProvider('codex')).toBe(true);
    expect(isHeadlessProvider('gemini')).toBe(true);
  });

  it('treats GUI/custom providers as interactive', () => {
    // Mirrors accepts_prompt_pipe in src-tauri/src/providers.rs plus the custom-command path.
    expect(isHeadlessProvider('cursor')).toBe(false);
    expect(isHeadlessProvider('copilot')).toBe(false);
    expect(isHeadlessProvider('custom')).toBe(false);
  });

  it('defaults undefined to headless (swarm agents pipe by default)', () => {
    expect(isHeadlessProvider(undefined)).toBe(true);
  });
});

describe('providerKeychainService', () => {
  it('follows the saple_provider_<id>_api_key contract shared with keychain.rs', () => {
    expect(providerKeychainService('codex')).toBe('saple_provider_codex_api_key');
    expect(providerKeychainService('claude')).toBe('saple_provider_claude_api_key');
    for (const p of Object.keys(PROVIDER_LABELS) as AgentProvider[]) {
      expect(providerKeychainService(p)).toMatch(/^saple_provider_[a-z0-9_]+_api_key$/);
    }
  });
});

describe('provider fact tables', () => {
  it('cover every AgentProvider', () => {
    const all = Object.keys(PROVIDER_LABELS) as AgentProvider[];
    for (const p of all) {
      expect(PROVIDER_CLI_COMMAND[p]).toBeDefined();
      expect(PROVIDER_DEFAULT_MODEL[p]).toBeTruthy();
    }
  });

  it('gives CLI-less providers no readiness command and no sign-in flow', () => {
    // openrouter is API-key/env only; custom is operator-typed.
    expect(PROVIDER_CLI_COMMAND.openrouter).toBe('');
    expect(PROVIDER_CLI_COMMAND.custom).toBe('');
    expect(SIGN_IN_COMMANDS.openrouter).toBeUndefined();
    expect(SIGN_IN_COMMANDS.custom).toBeUndefined();
    // Sign-in flows launch the provider's own CLI login command.
    expect(SIGN_IN_COMMANDS.claude).toBe('claude');
    expect(SIGN_IN_COMMANDS.codex).toBe('codex login');
  });
});
