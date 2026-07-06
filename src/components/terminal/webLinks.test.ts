import { describe, expect, it } from 'vitest';
import { findUrlMatches, offsetsToBufferRange, trimTrailingPunctuation } from './webLinks';

describe('trimTrailingPunctuation', () => {
  it('strips sentence punctuation that follows a URL', () => {
    expect(trimTrailingPunctuation('https://example.com.')).toBe('https://example.com');
    expect(trimTrailingPunctuation('https://example.com,')).toBe('https://example.com');
    expect(trimTrailingPunctuation('https://example.com!?')).toBe('https://example.com');
  });

  it('keeps balanced parentheses but drops an unbalanced closer', () => {
    expect(trimTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe(
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    );
    expect(trimTrailingPunctuation('https://example.com)')).toBe('https://example.com');
  });

  it('leaves a clean URL untouched', () => {
    expect(trimTrailingPunctuation('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });
});

describe('findUrlMatches', () => {
  it('finds a single URL with its offsets', () => {
    const text = 'see http://a.co here';
    const matches = findUrlMatches(text);
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('http://a.co');
    expect(text.slice(matches[0].startIndex, matches[0].endIndex)).toBe('http://a.co');
  });

  it('finds multiple URLs on one line', () => {
    const matches = findUrlMatches('https://one.example and https://two.example');
    expect(matches.map((m) => m.text)).toEqual(['https://one.example', 'https://two.example']);
  });

  it('ignores non-http text', () => {
    expect(findUrlMatches('ftp://nope just words')).toEqual([]);
  });
});

describe('offsetsToBufferRange', () => {
  it('maps offsets within a single row (1-based, inclusive end)', () => {
    // "http://a.co" starts at index 4, length 11 → ends at index 14 (exclusive 15).
    const range = offsetsToBufferRange(4, 15, 80, 1);
    expect(range.start).toEqual({ x: 5, y: 1 });
    expect(range.end).toEqual({ x: 15, y: 1 });
  });

  it('maps offsets that wrap across rows using cols', () => {
    // cols=10, startY=3. A match spanning indices 8..12 (exclusive) crosses the row edge.
    const range = offsetsToBufferRange(8, 12, 10, 3);
    expect(range.start).toEqual({ x: 9, y: 3 }); // index 8 → col 9, row 3
    expect(range.end).toEqual({ x: 2, y: 4 }); // last index 11 → col 2, row 4
  });
});
