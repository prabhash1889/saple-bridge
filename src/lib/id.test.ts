import { describe, it, expect } from 'vitest';
import { createId } from './id';

describe('createId', () => {
  it('prefixes ids and keeps them unique', () => {
    const a = createId('agent');
    const b = createId('agent');
    expect(a).toMatch(/^agent_/);
    expect(a).not.toBe(b);
  });

  it('normalizes unsafe prefixes', () => {
    expect(createId('a b/c')).toMatch(/^a_b_c_/);
    expect(createId('   ')).toMatch(/^id_/);
  });
});
