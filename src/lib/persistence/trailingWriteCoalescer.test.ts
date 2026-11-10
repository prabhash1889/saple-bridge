import { describe, expect, it, vi } from 'vitest';
import { createWriteCoalescer } from './trailingWriteCoalescer';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createWriteCoalescer', () => {
  it('runs the first submission immediately and resolves the caller after the write', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const coalescer = createWriteCoalescer(run);

    const done = coalescer.submit('a');
    expect(run).toHaveBeenCalledTimes(1);
    expect(coalescer.isPending('a')).toBe(true);

    gate.resolve();
    await done;
    expect(coalescer.isPending('a')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('coalesces submissions during an in-flight write into one trailing write with the latest state', async () => {
    const observations: string[] = [];
    let value = 'first';
    const gates: Deferred[] = [];
    const coalescer = createWriteCoalescer(async () => {
      observations.push(value);
      const gate = deferred();
      gates.push(gate);
      return gate.promise;
    });

    const first = coalescer.submit('a');
    value = 'second';
    const second = coalescer.submit('a');
    expect(second).toBe(first);
    expect(coalescer.coalescedCount()).toBe(1);

    gates[0].resolve();
    await first;
    // Exactly one trailing write runs and serializes the latest mutated state.
    expect(observations).toEqual(['first', 'second']);
    expect(coalescer.isPending('a')).toBe(true);

    gates[1].resolve();
    await vi.waitFor(() => expect(coalescer.isPending('a')).toBe(false));
    expect(observations).toHaveLength(2);
  });

  it('does not schedule a trailing write when nothing was coalesced during the write', async () => {
    const gate = deferred();
    const run = vi.fn(() => gate.promise);
    const coalescer = createWriteCoalescer(run);

    const done = coalescer.submit('a');
    gate.resolve();
    await done;
    // Give any (wrongly) scheduled trailing write a chance to surface.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('keeps different keys independent', async () => {
    const gates = new Map<string, Deferred>();
    const run = vi.fn((key: string) => {
      const gate = deferred();
      gates.set(key, gate);
      return gate.promise;
    });
    const coalescer = createWriteCoalescer(run);

    const a = coalescer.submit('a');
    const b = coalescer.submit('b');
    expect(a).not.toBe(b);
    expect(coalescer.coalescedCount()).toBe(0);

    gates.get('a')!.resolve();
    await a;
    expect(coalescer.isPending('a')).toBe(false);
    expect(coalescer.isPending('b')).toBe(true);

    gates.get('b')!.resolve();
    await b;
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('propagates runner errors and clears pending state so later writes can proceed', async () => {
    let calls = 0;
    const coalescer = createWriteCoalescer(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    });

    await expect(coalescer.submit('a')).rejects.toThrow('boom');
    expect(coalescer.isPending('a')).toBe(false);

    await expect(coalescer.submit('a')).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
