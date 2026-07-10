// Agent lifecycle marker detection, shared by the terminal output listener (fast path) and
// tests. Markers are matched against a rolling per-pane tail so a marker split across two PTY
// bursts — e.g. `[AGENT_` in one chunk and `DONE]` in the next — is still detected. The regexes
// are line-anchored (`/m`) so a marker only fires when an agent emits it on its own line, not
// when it's echoed mid-sentence or printed back inside a command the user typed.
//
// Two flavours exist:
//   - Bare markers (`[AGENT_DONE]`) — used by kanban task panes and interactive terminals, which
//     have no per-agent identity, and by swarm agents seeded before scoped markers existed.
//   - Scoped markers (`[AGENT_DONE:<token>]`) — used by swarm agents. Each agent is launched with
//     its own random token, so one agent can't be completed by another pane's output, by a shared
//     log line, or by narrating the generic marker name. A bare marker never advances a scoped
//     agent.
export const SIGNAL_DONE_RE = /^\s*\[(?:AGENT_DONE|TASK_COMPLETE|TASK_DONE)\]\s*$/m;
export const SIGNAL_FAILED_RE = /^\s*\[(?:AGENT_FAILED|TASK_FAILED)\]\s*$/m;
export const SIGNAL_REVIEW_RE =
  /^\s*(?:\[(?:AGENT_REVIEW|REVIEW_REQUESTED)\]|##\s*REVIEW REQUIRED|Task complete\. Review required\.)\s*$/m;

// A marker token is restricted to this charset so it can be interpolated straight into a RegExp
// without escaping. Tokens are minted by the swarm store (see `createMarker`); anything outside
// this shape is treated as "no marker" and falls back to bare matching.
const MARKER_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

// Compiled scoped regexes are cached per token — the same handful of agent tokens are matched
// against every PTY burst, so recompiling on each call would be wasteful.
const scopedCache = new Map<string, { done: RegExp; failed: RegExp; review: RegExp }>();

const scopedFor = (marker: string) => {
  const cached = scopedCache.get(marker);
  if (cached) return cached;
  // `marker` is validated against MARKER_TOKEN_RE before we get here, so direct interpolation is
  // safe (no regex metacharacters).
  const built = {
    done: new RegExp(`^\\s*\\[(?:AGENT_DONE|TASK_COMPLETE|TASK_DONE):${marker}\\]\\s*$`, 'm'),
    failed: new RegExp(`^\\s*\\[(?:AGENT_FAILED|TASK_FAILED):${marker}\\]\\s*$`, 'm'),
    review: new RegExp(`^\\s*\\[(?:AGENT_REVIEW|REVIEW_REQUESTED):${marker}\\]\\s*$`, 'm'),
  };
  scopedCache.set(marker, built);
  return built;
};

const hasMarker = (marker?: string): marker is string => !!marker && MARKER_TOKEN_RE.test(marker);

// When `marker` is a valid token, only that agent's scoped review marker matches; otherwise the
// bare review markers (including the freeform `## REVIEW REQUIRED` variants) apply.
export const hasReviewSignal = (tail: string, marker?: string) =>
  hasMarker(marker) ? scopedFor(marker).review.test(tail) : SIGNAL_REVIEW_RE.test(tail);

// Cheap substring pre-filter run before the regex battery: every lifecycle marker contains one
// of these literals (`[` for the bracketed markers, `#` for `## REVIEW REQUIRED`, or the
// `Task complete` phrase). Ordinary terminal output has none, so this short-circuits the regex
// tests for the overwhelmingly common no-marker case on the per-event hot path.
export const mightContainSignal = (tail: string) =>
  tail.includes('[') || tail.includes('#') || tail.includes('Task complete');

// A stronger pre-filter for the swarm branch: only worth importing the swarm store and scanning
// agents when the tail actually contains a marker keyword. A user typing `arr[0]` passes the
// coarse `mightContainSignal` filter but not this one, so it never reaches for swarm state.
export const mightContainAgentMarker = (tail: string) =>
  tail.includes('AGENT_') || tail.includes('TASK_') || tail.includes('REVIEW');

// `reviewMatched` is the already-computed `hasReviewSignal` result (with the same `marker`),
// threaded in so the review regex isn't run a second time here.
export const getSwarmStatusFromOutput = (tail: string, reviewMatched: boolean, marker?: string) => {
  if (hasMarker(marker)) {
    const scoped = scopedFor(marker);
    if (scoped.done.test(tail)) return 'done' as const;
    if (scoped.failed.test(tail)) return 'failed' as const;
    if (reviewMatched) return 'review' as const;
    return null;
  }
  if (SIGNAL_DONE_RE.test(tail)) return 'done' as const;
  if (SIGNAL_FAILED_RE.test(tail)) return 'failed' as const;
  if (reviewMatched) return 'review' as const;
  return null;
};

// Completion fallback for an agent whose PTY exited without ever printing a marker: a clean or
// unknown exit parks it in review (a human confirms; auto-approve agents advance to done), a
// non-zero exit fails it. Markers stay the fast path; this is the safety net that guarantees a
// terminal state.
export const exitFallbackTransition = (exitCode: number | null | undefined) => {
  const failed = typeof exitCode === 'number' && exitCode !== 0;
  return failed
    ? {
        status: 'failed' as const,
        statusReason: `Process exited with code ${exitCode} without a completion signal.`,
      }
    : {
        status: 'review' as const,
        statusReason: 'Process exited without a completion signal — review the output and approve.',
      };
};
