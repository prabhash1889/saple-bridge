//! Realtime swarm event bus (Phase 1).
//!
//! Rust's swarm-dir watcher emits `swarm-file-changed { projectPath, relPath }` on every external
//! edit under `.saple/swarm/`. This module owns the single Tauri listener for that event (mirrors
//! `startPtyOutputListener`), classifies `relPath` into a category, and fans it out to subscribers.
//! Callers subscribe to react to just the files they care about instead of polling on an interval.

import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type SwarmFileCategory =
  | 'plan' // plan.json
  | 'state' // state.json (Bridge-owned; usually filtered as our own write, but surfaced if external)
  | 'requests' // requests.json (legacy P6 worker requests)
  | 'verdict' // verdicts/*.json
  | 'outcome' // outcomes/*.json
  | 'mailbox' // mailbox/*.md
  | 'handoff' // handoffs/*.json
  | 'unknown';

export interface SwarmFileEvent {
  projectPath: string;
  /** Path relative to `.saple/swarm/`, forward-slashed. */
  relPath: string;
  category: SwarmFileCategory;
}

/** Classify a `.saple/swarm/`-relative path into the reaction it should drive. */
export function classifySwarmPath(relPath: string): SwarmFileCategory {
  const p = relPath.replace(/\\/g, '/');
  if (p === 'plan.json') return 'plan';
  if (p === 'state.json') return 'state';
  if (p === 'requests.json') return 'requests';
  if (p.startsWith('verdicts/')) return 'verdict';
  if (p.startsWith('outcomes/')) return 'outcome';
  if (p.startsWith('mailbox/')) return 'mailbox';
  if (p.startsWith('handoffs/')) return 'handoff';
  return 'unknown';
}

type Handler = (event: SwarmFileEvent) => void;

const handlers = new Set<Handler>();
let unlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

/** Start the module-level listener once. Idempotent; safe to call from every subscriber. */
async function ensureListener(): Promise<void> {
  if (unlisten) return;
  if (starting) return starting;
  starting = listen<{ projectPath: string; relPath: string }>('swarm-file-changed', (event) => {
    const { projectPath, relPath } = event.payload;
    const classified: SwarmFileEvent = { projectPath, relPath, category: classifySwarmPath(relPath) };
    for (const handler of Array.from(handlers)) handler(classified);
  }).then((fn) => {
    unlisten = fn;
    starting = null;
  });
  return starting;
}

/**
 * Subscribe to classified swarm file events. Returns an unsubscribe function. The Tauri listener is
 * lazily started on the first subscription and torn down when the last subscriber leaves.
 */
export function subscribeSwarmEvents(handler: Handler): () => void {
  handlers.add(handler);
  void ensureListener();
  return () => {
    handlers.delete(handler);
    if (handlers.size === 0 && unlisten) {
      void unlisten();
      unlisten = null;
    }
  };
}
