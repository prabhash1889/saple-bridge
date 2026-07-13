import { describe, it, expect } from 'vitest';
import { formatDroppedPaths } from './terminalFileDrop';

describe('formatDroppedPaths', () => {
  it('leaves plain paths bare, quotes ones with spaces', () => {
    expect(formatDroppedPaths(['C:\\a\\b.png'])).toBe('C:\\a\\b.png ');
    expect(formatDroppedPaths(['C:\\my pics\\b.png'])).toBe('"C:\\my pics\\b.png" ');
  });

  it('space-joins multiple paths', () => {
    expect(formatDroppedPaths(['/a/b.png', '/c d/e.png'])).toBe('/a/b.png "/c d/e.png" ');
  });
});
