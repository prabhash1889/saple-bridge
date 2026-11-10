import { describe, expect, it, vi } from 'vitest';
import { writeClipboardTextWithRetry } from './clipboard';

describe('writeClipboardTextWithRetry', () => {
  it('resolves on the first successful write without sleeping', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await writeClipboardTextWithRetry(write, 'copied text', { sleep });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('copied text');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries with growing backoff until a write succeeds', async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('clipboard busy'))
      .mockRejectedValueOnce(new Error('clipboard busy'))
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await writeClipboardTextWithRetry(write, 'copied text', { baseDelayMs: 50, sleep });

    expect(write).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 50);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it('throws the last error once attempts are exhausted', async () => {
    const lastError = new Error('still locked');
    const write = vi
      .fn()
      .mockRejectedValueOnce(new Error('clipboard busy'))
      .mockRejectedValue(lastError);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      writeClipboardTextWithRetry(write, 'copied text', { attempts: 3, sleep }),
    ).rejects.toBe(lastError);
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('does not sleep after the final failed attempt', async () => {
    const write = vi.fn().mockRejectedValue(new Error('clipboard busy'));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      writeClipboardTextWithRetry(write, 'copied text', { attempts: 2, sleep }),
    ).rejects.toThrow('clipboard busy');
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
