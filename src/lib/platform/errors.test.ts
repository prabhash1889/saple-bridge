import { describe, expect, it } from 'vitest';
import { hasIpcErrorCode, parseIpcError, toErrorMessage } from './errors';

describe('parseIpcError', () => {
  it('extracts code and message from a CodedError-shaped rejection', () => {
    const info = parseIpcError({ code: 'pty_not_found', message: 'PTY session a1 not found' });
    expect(info).toEqual({ code: 'pty_not_found', message: 'PTY session a1 not found' });
  });

  it('returns null code for plain-string rejections (unmigrated surfaces)', () => {
    expect(parseIpcError('PTY session a1 not found')).toEqual({
      code: null,
      message: 'PTY session a1 not found',
    });
  });

  it('returns null code for Error objects', () => {
    const info = parseIpcError(new Error('boom'));
    expect(info.code).toBeNull();
    expect(info.message).toBe('boom');
  });

  it('falls back to the stringified error when code is present but message is not', () => {
    const info = parseIpcError({ code: 'internal', detail: 'x' });
    expect(info.code).toBe('internal');
    expect(info.message).toContain('internal');
  });

  it('never throws on exotic rejection values', () => {
    expect(parseIpcError(undefined).code).toBeNull();
    expect(parseIpcError(null).code).toBeNull();
    expect(parseIpcError(42).code).toBeNull();
  });
});

describe('hasIpcErrorCode', () => {
  it('matches coded rejections exactly', () => {
    expect(hasIpcErrorCode({ code: 'already_exists', message: 'taken' }, 'already_exists')).toBe(
      true,
    );
    expect(hasIpcErrorCode({ code: 'already_exists', message: 'taken' }, 'pty_not_found')).toBe(
      false,
    );
  });

  it('never matches text-only rejections', () => {
    expect(hasIpcErrorCode('Snapshot x already exists. Confirm overwrite.', 'already_exists')).toBe(
      false,
    );
    expect(hasIpcErrorCode(new Error('already exists'), 'already_exists')).toBe(false);
  });
});

describe('toErrorMessage', () => {
  it('prefers the message field of coded objects over raw JSON', () => {
    expect(toErrorMessage({ code: 'protected_path', message: '.git is protected' })).toBe(
      '.git is protected',
    );
  });

  it('keeps existing behavior for strings and Errors', () => {
    expect(toErrorMessage('plain')).toBe('plain');
    expect(toErrorMessage(new Error('e'))).toBe('e');
  });
});
