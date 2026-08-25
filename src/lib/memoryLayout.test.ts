import { describe, it, expect } from 'vitest';
import { memoryPathPrefix } from './memoryLayout';

describe('memoryPathPrefix', () => {
  it('uses the bridge directory only for bridge-compatible mode', () => {
    expect(memoryPathPrefix('bridge-compatible')).toBe('.bridgememory/');
  });

  it('falls back to the saple directory for every other mode', () => {
    expect(memoryPathPrefix('saple')).toBe('.saple/memory/');
    expect(memoryPathPrefix('both')).toBe('.saple/memory/');
    expect(memoryPathPrefix(undefined)).toBe('.saple/memory/');
  });
});
