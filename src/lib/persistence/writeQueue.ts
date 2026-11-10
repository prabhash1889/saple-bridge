// Serializes async writes to the same logical file so concurrent callers — rapid Kanban
// edits, the swarm scheduler ticking, an MCP-triggered save landing mid-drag — can't
// interleave and clobber each other's content.
//
// The Rust side already writes atomically (temp file + rename) under a per-path mutex, so
// a reader never sees a torn file. What that does *not* guarantee is ordering: if two saves
// are issued back-to-back, the OS/mutex may run them in either order, and the loser's stale
// snapshot wins on disk. This queue adds that ordering on the TS side — for a given key,
// each write starts only after the previous one settles, so the last save issued is the
// last one written.

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `task` after any previously-enqueued task for the same `key` has settled (resolved
 * *or* rejected — a failed write must not wedge the chain). Returns `task`'s own result so
 * callers still observe success/failure and can roll back optimistic UI state.
 */
export function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(task, task);
  // Store a swallowed copy as the chain tail so the next link always runs its task and we
  // never surface an unhandled rejection from the bookkeeping promise.
  chains.set(key, run.then(() => undefined, () => undefined));
  return run;
}
