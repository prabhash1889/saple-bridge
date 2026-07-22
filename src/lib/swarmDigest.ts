// Coordinator results digests (Phase 3). Pure formatting: the swarm store collects the entries
// (worker roster + best-effort outcome summaries) and either injects the built digest into the
// live coordinator's PTY as a user turn, or embeds it in a relaunch prompt (digest-relaunch
// fallback / crash recovery). Compact by design - a digest is typed into a TUI.
import type { AgentRole, AgentStatus } from '../types/agent';

export interface DigestEntry {
  taskId?: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  statusReason?: string;
  summary?: string;
}

export type DigestKind = 'wave' | 'task_failed' | 'crash_recovery';

const HEADERS: Record<DigestKind, (wave: number) => string> = {
  wave: (w) => `[Bridge digest] Wave ${w}: all worker tasks have finished.`,
  task_failed: (w) => `[Bridge digest] Wave ${w}: a task failed terminally.`,
  crash_recovery: (w) =>
    `[Bridge digest] Wave ${w}: your previous session ended unexpectedly. This is the swarm state so far.`,
};

// One line per worker: `- <taskId> (<name>) [role]: status - detail`. The outcome summary wins
// over the status reason when both exist (it is what the agent said it did; the reason is how it
// ended).
export function buildResultsDigest(
  entries: DigestEntry[],
  opts: { kind: DigestKind; wave: number; marker?: string },
): string {
  const lines = entries.map((e) => {
    const label = e.taskId ? `${e.taskId} (${e.name})` : e.name;
    const detail = e.summary || e.statusReason;
    return `- ${label} [${e.role}]: ${e.status}${detail ? ` - ${detail}` : ''}`;
  });
  const done = opts.marker ? `[AGENT_DONE:${opts.marker}]` : '[AGENT_DONE]';
  const updated = opts.marker ? `[PLAN_UPDATED:${opts.marker}]` : '[PLAN_UPDATED]';
  return [
    HEADERS[opts.kind](opts.wave),
    ...(lines.length > 0 ? lines : ['- (no worker tasks yet)']),
    '',
    `React now: if the mission is complete, write a short final report and emit ${done} on its own line. ` +
      `If more work is needed, append new tasks to .saple/swarm/plan.json and emit ${updated} on its own line.`,
  ].join('\n');
}
