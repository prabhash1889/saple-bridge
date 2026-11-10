import { describe, it, expect } from 'vitest';
import { classifySwarmPath } from './swarmEvents';

describe('classifySwarmPath', () => {
  it('classifies top-level files', () => {
    expect(classifySwarmPath('plan.json')).toBe('plan');
    expect(classifySwarmPath('state.json')).toBe('state');
    expect(classifySwarmPath('requests.json')).toBe('requests');
  });

  it('classifies files inside subdirs', () => {
    expect(classifySwarmPath('verdicts/fe_auth.json')).toBe('verdict');
    expect(classifySwarmPath('outcomes/agent-1.json')).toBe('outcome');
    expect(classifySwarmPath('mailbox/agent-1.md')).toBe('mailbox');
    expect(classifySwarmPath('handoffs/a-to-b.json')).toBe('handoff');
  });

  it('normalizes backslashes (Windows watcher paths)', () => {
    expect(classifySwarmPath('mailbox\\agent-1.md')).toBe('mailbox');
    expect(classifySwarmPath('verdicts\\x.json')).toBe('verdict');
  });

  it('returns unknown for anything unrecognized', () => {
    expect(classifySwarmPath('context/notes.md')).toBe('unknown');
    expect(classifySwarmPath('random.txt')).toBe('unknown');
    expect(classifySwarmPath('')).toBe('unknown');
    // A dir named like a prefix without a trailing slash is not a match.
    expect(classifySwarmPath('mailboxes.json')).toBe('unknown');
  });
});
