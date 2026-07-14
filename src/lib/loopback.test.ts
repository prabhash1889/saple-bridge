import { describe, it, expect } from 'vitest';
import { isLoopbackUrl, parseLoopbackUrl } from './loopback';

describe('parseLoopbackUrl', () => {
  it('accepts the three loopback hosts, with or without scheme/port/path', () => {
    expect(isLoopbackUrl('http://localhost:3000')).toBe(true);
    expect(isLoopbackUrl('localhost:5173/app')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8080')).toBe(true);
    expect(isLoopbackUrl('https://[::1]:4000')).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isLoopbackUrl('http://example.com')).toBe(false);
    expect(isLoopbackUrl('http://10.0.0.5:3000')).toBe(false);
    expect(isLoopbackUrl('http://localhost.evil.com')).toBe(false);
  });

  it('rejects non-http(s) schemes and junk', () => {
    expect(isLoopbackUrl('file:///etc/passwd')).toBe(false);
    expect(isLoopbackUrl('javascript:alert(1)')).toBe(false);
    expect(isLoopbackUrl('')).toBe(false);
    expect(isLoopbackUrl('   ')).toBe(false);
  });

  it('normalizes a bare host to an http URL', () => {
    expect(parseLoopbackUrl('localhost:3000')?.href).toBe('http://localhost:3000/');
  });
});
