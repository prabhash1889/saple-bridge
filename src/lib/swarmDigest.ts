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
const entryLines = (entries: DigestEntry[]): string[] => {
  const lines = entries.map((e) => {
    const label = e.taskId ? `${e.taskId} (${e.name})` : e.name;
    const detail = e.summary || e.statusReason;
    return `- ${label} [${e.role}]: ${e.status}${detail ? ` - ${detail}` : ''}`;
  });
  return lines.length > 0 ? lines : ['- (no worker tasks yet)'];
};

export function buildResultsDigest(
  entries: DigestEntry[],
  opts: { kind: DigestKind; wave: number; marker?: string },
): string {
  const done = opts.marker ? `[AGENT_DONE:${opts.marker}]` : '[AGENT_DONE]';
  const updated = opts.marker ? `[PLAN_UPDATED:${opts.marker}]` : '[PLAN_UPDATED]';
  return [
    HEADERS[opts.kind](opts.wave),
    ...entryLines(entries),
    '',
    `React now: if the mission is complete, write a short final report and emit ${done} on its own line. ` +
      `If more work is needed, append new tasks to .saple/swarm/plan.json and emit ${updated} on its own line.`,
  ].join('\n');
}

// Digests are typed into a TUI, so only the tail of the acceptance output (where test runners put
// the failures) rides along; the full truncated output lives in state/escalation.json.
const ACCEPTANCE_OUTPUT_TAIL_CHARS = 2000;

// Phase 5: the acceptance-result digest. Pass -> ask the coordinator for the final report (its
// structured outcome doubles as the control-plane artifact). Fail -> ask for repair tasks via
// PLAN_UPDATED, with the failing output tail embedded.
export function buildAcceptanceDigest(
  entries: DigestEntry[],
  opts: {
    passed: boolean;
    command: string;
    wave: number;
    maxWaves: number;
    output: string;
    marker?: string;
    outcomePath?: string;
  },
): string {
  const done = opts.marker ? `[AGENT_DONE:${opts.marker}]` : '[AGENT_DONE]';
  const updated = opts.marker ? `[PLAN_UPDATED:${opts.marker}]` : '[PLAN_UPDATED]';
  if (opts.passed) {
    return [
      `[Bridge digest] Wave ${opts.wave}: all tasks are done and approved, and the acceptance command passed.`,
      `Acceptance: \`${opts.command}\` exited 0.`,
      ...entryLines(entries),
      '',
      `Write the final report now: a short summary of what was built and how it was verified` +
        `${opts.outcomePath ? `, saved as your structured outcome at ${opts.outcomePath} (summary field)` : ''}. ` +
        `Then emit ${done} on its own line.`,
    ].join('\n');
  }
  const tail = opts.output.trim().slice(-ACCEPTANCE_OUTPUT_TAIL_CHARS);
  return [
    `[Bridge digest] Wave ${opts.wave} of ${opts.maxWaves}: all tasks finished but the acceptance command FAILED.`,
    `Acceptance: \`${opts.command}\` exited non-zero.`,
    ...entryLines(entries),
    '',
    'Acceptance output (tail):',
    '```',
    tail || '(no output)',
    '```',
    '',
    `Diagnose the failure and append repair tasks to .saple/swarm/plan.json (new unique ids; never re-add completed ones), then emit ${updated} on its own line.`,
  ].join('\n');
}

// Phase 5 identical-failure short-circuit: two consecutive acceptance failures with the same
// trimmed output hash mean the repair wave changed nothing - escalate instead of looping.
// djb2 over the trimmed output; collisions only risk a premature escalation report, never a wrong
// completion.
export function hashAcceptanceOutput(output: string): string {
  const s = output.trim();
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
