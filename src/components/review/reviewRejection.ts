// Rejection flow for the Review Room. Reviewer notes are persisted through the
// review-record backend path (`submit_review_decision`); they are never typed
// into an agent terminal. The agent resumes via the structured rejected-state
// transition (task/session reload) or explicit operator action in its pane.

// eslint-disable-next-line no-control-regex -- matching control characters is exactly the purpose of this pattern
const UNSAFE_PTY_PATTERN = /\$\(|`|&&|[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * Belt-and-braces gate for anything that might be written to a live PTY:
 * shell metasequences (`$()`, backticks, `&&`) and control characters are
 * rejected so no review note can ever become shell input.
 */
export function containsUnsafePtyContent(text: string): boolean {
  return UNSAFE_PTY_PATTERN.test(text);
}

export interface RejectionFlowDeps {
  projectPath: string;
  taskId: string;
  notes: string;
  submitReviewDecision: (
    projectPath: string,
    taskId: string,
    decision: 'approve' | 'reject',
    notes?: string
  ) => Promise<void>;
  loadTasks: (projectPath: string, force?: boolean) => Promise<unknown>;
  loadSessions: (projectPath: string, force?: boolean) => Promise<unknown>;
}

/**
 * Persist a rejection (with reviewer notes) through the existing backend
 * record path, then reload tasks and sessions so the structured rejected
 * state propagates. Contains no `write_pty` usage by design.
 */
export async function runRejectionFlow(deps: RejectionFlowDeps): Promise<void> {
  await deps.submitReviewDecision(deps.projectPath, deps.taskId, 'reject', deps.notes);
  await deps.loadTasks(deps.projectPath, true);
  await deps.loadSessions(deps.projectPath, true);
}
