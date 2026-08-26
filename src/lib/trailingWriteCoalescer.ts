export type WriteRunner<K> = (key: K) => Promise<void>;

export interface WriteCoalescer<K> {
  submit(key: K): Promise<void>;
  isPending(key: K): boolean;
  coalescedCount(): number;
}

/**
 * Trailing-edge write coalescer for keyed full-state saves. While a write for a key is in
 * flight, further submissions for that key do not queue more writes; they mark the cycle
 * dirty and one trailing write runs afterwards, serializing the latest state. Submissions
 * for different keys never interact.
 */
export function createWriteCoalescer<K>(runner: WriteRunner<K>): WriteCoalescer<K> {
  const active = new Map<K, { promise: Promise<void>; markDirty: () => void }>();
  let coalesced = 0;

  const submit = (key: K): Promise<void> => {
    const existing = active.get(key);
    if (existing) {
      coalesced += 1;
      existing.markDirty();
      return existing.promise;
    }
    let dirty = false;
    const entry: { promise: Promise<void>; markDirty: () => void } = {
      promise: null as unknown as Promise<void>,
      markDirty: () => {
        dirty = true;
      },
    };
    entry.promise = (async () => {
      try {
        await runner(key);
      } finally {
        active.delete(key);
      }
      if (dirty && !active.has(key)) {
        void submit(key);
      }
    })();
    active.set(key, entry);
    return entry.promise;
  };

  return {
    submit,
    isPending: (key) => active.has(key),
    coalescedCount: () => coalesced,
  };
}
