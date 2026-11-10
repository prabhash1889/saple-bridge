import { describe, it, expect } from 'vitest';
import { formatElapsed, swarmStatusColor } from './swarmStatus';

describe('formatElapsed', () => {
  it('shows seconds under a minute', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
  });

  it('shows minutes and zero-padded seconds under an hour', () => {
    expect(formatElapsed(60_000)).toBe('1m 00s');
    expect(formatElapsed(184_000)).toBe('3m 04s');
  });

  it('shows hours and zero-padded minutes past an hour', () => {
    expect(formatElapsed(3_600_000)).toBe('1h 00m');
    expect(formatElapsed(3_600_000 + 5 * 60_000)).toBe('1h 05m');
  });

  it('clamps negatives to zero', () => {
    expect(formatElapsed(-5_000)).toBe('0s');
  });
});

describe('swarmStatusColor', () => {
  it('maps running and starting to the same active accent', () => {
    expect(swarmStatusColor('running')).toBe(swarmStatusColor('starting'));
  });

  it('gives terminal states distinct colors', () => {
    const colors = ['done', 'failed', 'review', 'waiting', 'blocked'].map((s) =>
      swarmStatusColor(s as never),
    );
    expect(new Set(colors).size).toBe(colors.length);
  });
});
