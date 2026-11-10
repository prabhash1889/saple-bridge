import { describe, it, expect } from 'vitest';
import { enqueueWrite } from './writeQueue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('enqueueWrite', () => {
  it('runs tasks for the same key strictly in order, even when earlier tasks are slower', async () => {
    const order: number[] = [];
    const first = enqueueWrite('k', async () => {
      await sleep(30);
      order.push(1);
    });
    const second = enqueueWrite('k', async () => {
      order.push(2);
    });
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('does not serialize across different keys', async () => {
    const order: string[] = [];
    const slow = enqueueWrite('a', async () => {
      await sleep(30);
      order.push('a');
    });
    const fast = enqueueWrite('b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['b', 'a']);
  });

  it('a rejected task surfaces to its caller without wedging the chain', async () => {
    const failing = enqueueWrite('k2', async () => {
      throw new Error('disk full');
    });
    await expect(failing).rejects.toThrow('disk full');

    // The next write on the same key still runs.
    const result = await enqueueWrite('k2', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('returns the task result to the caller', async () => {
    await expect(enqueueWrite('k3', async () => 42)).resolves.toBe(42);
  });
});
