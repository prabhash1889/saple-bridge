import { describe, expect, it } from 'vitest';
import { contextLeftPercent, contextWindowFor } from './claudeContext';

describe('contextWindowFor', () => {
  it('defaults to the 200k window', () => {
    expect(contextWindowFor('claude-opus-4-8')).toBe(200_000);
    expect(contextWindowFor('')).toBe(200_000);
  });

  it('recognizes explicit 1M-context model ids', () => {
    expect(contextWindowFor('claude-sonnet-5[1m]')).toBe(1_000_000);
  });

  it('recognizes natively-1M model families without a [1m] marker', () => {
    expect(contextWindowFor('claude-fable-5')).toBe(1_000_000);
    expect(contextWindowFor('claude-mythos-5')).toBe(1_000_000);
  });
});

describe('contextLeftPercent', () => {
  it('computes remaining percent of the window', () => {
    expect(contextLeftPercent(100_000, 'claude-opus-4-8')).toBe(50);
    expect(contextLeftPercent(30_000, 'claude-opus-4-8')).toBe(85);
    expect(contextLeftPercent(500_000, 'claude-sonnet-5[1m]')).toBe(50);
  });

  it('infers a 1M window once usage exceeds 200k, even without a marker', () => {
    expect(contextLeftPercent(500_000, 'claude-opus-4-8')).toBe(50);
    expect(contextLeftPercent(700_000, 'claude-sonnet-5')).toBe(30);
  });

  it('clamps to 0..100 even with over-window usage or zero usage', () => {
    expect(contextLeftPercent(0, 'claude-opus-4-8')).toBe(100);
    expect(contextLeftPercent(1_999_999, 'claude-opus-4-8')).toBe(0);
  });
});
