import { describe, it, expect } from 'vitest';
import { parseAgentOutcome } from './controlPlane';

describe('parseAgentOutcome (P3 robustness)', () => {
  it('keeps well-typed fields', () => {
    const out = parseAgentOutcome({
      summary: 'Fixed the auth race',
      changedFiles: ['src/auth.ts'],
      tests: { command: 'npm test', passed: true },
      decisions: ['kept refresh-token locking'],
      needsReview: true,
    });
    expect(out).toEqual({
      summary: 'Fixed the auth race',
      changedFiles: ['src/auth.ts'],
      tests: { command: 'npm test', passed: true },
      decisions: ['kept refresh-token locking'],
      needsReview: true,
    });
  });

  it('drops wrong-typed fields instead of throwing', () => {
    const out = parseAgentOutcome({
      summary: 42, // wrong type → dropped
      changedFiles: ['ok', 5, null], // non-strings filtered out
      tests: { command: 'go test', passed: 'yes' }, // passed wrong type → dropped
      decisions: 'not an array', // dropped
      needsReview: 'true', // wrong type → dropped
    });
    expect(out).toEqual({
      changedFiles: ['ok'],
      tests: { command: 'go test' },
    });
  });

  it('returns null for empty or non-object input', () => {
    expect(parseAgentOutcome(null)).toBeNull();
    expect(parseAgentOutcome('nope')).toBeNull();
    expect(parseAgentOutcome({})).toBeNull();
    expect(parseAgentOutcome({ unrelated: 'field' })).toBeNull();
  });
});
