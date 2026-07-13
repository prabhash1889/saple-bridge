import { describe, it, expect } from 'vitest';
import { isHeadlessProvider } from './provider';

describe('isHeadlessProvider', () => {
  it('treats piped-prompt CLIs as headless', () => {
    expect(isHeadlessProvider('claude')).toBe(true);
    expect(isHeadlessProvider('codex')).toBe(true);
    expect(isHeadlessProvider('gemini')).toBe(true);
  });

  it('treats GUI/custom providers as interactive', () => {
    // Mirrors provider_accepts_prompt_pipe in pty.rs plus the custom-command path.
    expect(isHeadlessProvider('cursor')).toBe(false);
    expect(isHeadlessProvider('copilot')).toBe(false);
    expect(isHeadlessProvider('custom')).toBe(false);
  });

  it('defaults undefined to headless (swarm agents pipe by default)', () => {
    expect(isHeadlessProvider(undefined)).toBe(true);
  });
});
