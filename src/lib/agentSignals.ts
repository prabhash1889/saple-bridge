// Agent lifecycle marker detection, shared by the terminal output listener (fast path) and
// tests. Markers are matched against a rolling per-pane tail so a marker split across two PTY
// bursts — e.g. `[AGENT_` in one chunk and `DONE]` in the next — is still detected. The regexes
// are line-anchored (`/m`) so a marker only fires when an agent emits it on its own line, not
// when it's echoed mid-sentence or printed back inside a command the user typed.
export const SIGNAL_DONE_RE = /^\s*\[(?:AGENT_DONE|TASK_COMPLETE|TASK_DONE)\]\s*$/m;
export const SIGNAL_FAILED_RE = /^\s*\[(?:AGENT_FAILED|TASK_FAILED)\]\s*$/m;
export const SIGNAL_REVIEW_RE =
  /^\s*(?:\[(?:AGENT_REVIEW|REVIEW_REQUESTED)\]|##\s*REVIEW REQUIRED|Task complete\. Review required\.)\s*$/m;

export const hasReviewSignal = (tail: string) => SIGNAL_REVIEW_RE.test(tail);

// Cheap substring pre-filter run before the regex battery: every lifecycle marker contains one
// of these literals (`[` for the bracketed markers, `#` for `## REVIEW REQUIRED`, or the
// `Task complete` phrase). Ordinary terminal output has none, so this short-circuits the regex
// tests for the overwhelmingly common no-marker case on the per-event hot path.
export const mightContainSignal = (tail: string) =>
  tail.includes('[') || tail.includes('#') || tail.includes('Task complete');

// `reviewMatched` is the already-computed `hasReviewSignal` result, threaded in so the review
// regex isn't run a second time here.
export const getSwarmStatusFromOutput = (tail: string, reviewMatched: boolean) => {
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
