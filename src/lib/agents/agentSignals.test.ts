import { describe, it, expect } from 'vitest';
import {
  hasReviewSignal,
  mightContainSignal,
  mightContainAgentMarker,
  getSwarmStatusFromOutput,
  getPlanSignalFromOutput,
  exitFallbackTransition,
} from './agentSignals';

// Convenience: run the same pipeline the pty-output listener runs.
const detect = (tail: string, marker?: string) =>
  getSwarmStatusFromOutput(tail, hasReviewSignal(tail, marker), marker);

describe('lifecycle marker detection', () => {
  it('detects each done marker on its own line', () => {
    expect(detect('working...\n[AGENT_DONE]\n')).toBe('done');
    expect(detect('output\n[TASK_COMPLETE]\n')).toBe('done');
    expect(detect('output\n[TASK_DONE]\n')).toBe('done');
  });

  it('detects failure and review markers', () => {
    expect(detect('boom\n[AGENT_FAILED]\n')).toBe('failed');
    expect(detect('boom\n[TASK_FAILED]\n')).toBe('failed');
    expect(detect('\n[REVIEW_REQUESTED]\n')).toBe('review');
    expect(detect('\n## REVIEW REQUIRED\n')).toBe('review');
    expect(detect('\nTask complete. Review required.\n')).toBe('review');
  });

  it('ignores markers echoed mid-sentence (not on their own line)', () => {
    expect(detect('when done, print [AGENT_DONE] on its own line\n')).toBeNull();
    expect(detect('echo "[TASK_FAILED]" is the failure marker\n')).toBeNull();
  });

  it('detects a marker split across two PTY bursts once the tail rejoins it', () => {
    const chunk1 = 'finishing up\n[AGENT_';
    const chunk2 = 'DONE]\n';
    expect(detect(chunk1)).toBeNull();
    expect(detect(chunk1 + chunk2)).toBe('done');
  });

  it('tolerates leading/trailing whitespace around a marker line', () => {
    expect(detect('\n   [AGENT_DONE]   \n')).toBe('done');
  });

  it('done takes precedence over review when both are present', () => {
    expect(detect('[REVIEW_REQUESTED]\n[AGENT_DONE]\n')).toBe('done');
  });
});

describe('scoped (per-agent) marker detection', () => {
  const marker = 'a1b2c3d4';

  it('detects an agent-scoped marker on its own line', () => {
    expect(detect(`done\n[AGENT_DONE:${marker}]\n`, marker)).toBe('done');
    expect(detect(`boom\n[AGENT_FAILED:${marker}]\n`, marker)).toBe('failed');
    expect(detect(`\n[REVIEW_REQUESTED:${marker}]\n`, marker)).toBe('review');
  });

  it('ignores a BARE marker for a scoped agent (anti-spoof)', () => {
    expect(detect('done\n[AGENT_DONE]\n', marker)).toBeNull();
    expect(detect('\n[REVIEW_REQUESTED]\n', marker)).toBeNull();
    expect(detect('\n## REVIEW REQUIRED\n', marker)).toBeNull();
  });

  it("ignores ANOTHER agent's scoped marker", () => {
    expect(detect(`\n[AGENT_DONE:deadbeef]\n`, marker)).toBeNull();
  });

  it('still requires the marker to be alone on its line', () => {
    expect(detect(`when done print [AGENT_DONE:${marker}] here\n`, marker)).toBeNull();
  });

  it('detects a scoped marker split across two PTY bursts', () => {
    const chunk1 = `wrapping up\n[AGENT_DONE:`;
    const chunk2 = `${marker}]\n`;
    expect(detect(chunk1, marker)).toBeNull();
    expect(detect(chunk1 + chunk2, marker)).toBe('done');
  });

  it('falls back to bare matching when the marker is missing or malformed', () => {
    expect(detect('\n[AGENT_DONE]\n', undefined)).toBe('done');
    expect(detect('\n[AGENT_DONE]\n', 'bad token!')).toBe('done');
  });
});

describe('mightContainAgentMarker pre-filter', () => {
  it('passes marker keywords and rejects ordinary bracketed output', () => {
    expect(mightContainAgentMarker('[AGENT_DONE:abc]')).toBe(true);
    expect(mightContainAgentMarker('[TASK_FAILED]')).toBe(true);
    expect(mightContainAgentMarker('## REVIEW REQUIRED')).toBe(true);
    expect(mightContainAgentMarker('[PLAN_READY:abc]')).toBe(true);
    expect(mightContainAgentMarker('const x = arr[0];')).toBe(false);
  });
});

describe('plan lifecycle marker detection', () => {
  const marker = 'c00rd1nat';

  it('detects scoped plan-ready and plan-updated markers on their own line', () => {
    expect(getPlanSignalFromOutput(`planning\n[PLAN_READY:${marker}]\n`, marker)).toBe('plan_ready');
    expect(getPlanSignalFromOutput(`repairing\n[PLAN_UPDATED:${marker}]\n`, marker)).toBe('plan_updated');
  });

  it('detects a plan marker split across two PTY bursts', () => {
    const chunk1 = `done planning\n[PLAN_READY:`;
    const chunk2 = `${marker}]\n`;
    expect(getPlanSignalFromOutput(chunk1, marker)).toBeNull();
    expect(getPlanSignalFromOutput(chunk1 + chunk2, marker)).toBe('plan_ready');
  });

  it('prefers plan_updated when both markers are present', () => {
    expect(getPlanSignalFromOutput(`[PLAN_READY:${marker}]\n[PLAN_UPDATED:${marker}]\n`, marker)).toBe(
      'plan_updated',
    );
  });

  it('ignores a marker echoed mid-sentence', () => {
    expect(getPlanSignalFromOutput(`when ready print [PLAN_READY:${marker}] here\n`, marker)).toBeNull();
  });

  it("ignores another coordinator's scoped marker and bare/missing markers", () => {
    expect(getPlanSignalFromOutput(`\n[PLAN_READY:deadbeef]\n`, marker)).toBeNull();
    expect(getPlanSignalFromOutput(`\n[PLAN_READY]\n`, marker)).toBeNull();
    expect(getPlanSignalFromOutput(`\n[PLAN_READY:${marker}]\n`, undefined)).toBeNull();
    expect(getPlanSignalFromOutput(`\n[PLAN_READY:${marker}]\n`, 'bad token!')).toBeNull();
  });
});

describe('mightContainSignal pre-filter', () => {
  it('passes every real marker through', () => {
    for (const marker of [
      '[AGENT_DONE]',
      '[TASK_FAILED]',
      '[REVIEW_REQUESTED]',
      '## REVIEW REQUIRED',
      'Task complete. Review required.',
    ]) {
      expect(mightContainSignal(`\n${marker}\n`)).toBe(true);
    }
  });

  it('rejects ordinary output so the regex battery is skipped', () => {
    expect(mightContainSignal('compiling module a.ts...\nDone in 3s\n')).toBe(false);
  });
});

describe('exitFallbackTransition', () => {
  it('parks a clean exit in review for human confirmation', () => {
    const t = exitFallbackTransition(0);
    expect(t.status).toBe('review');
    expect(t.statusReason).toMatch(/review/i);
  });

  it('fails a non-zero exit and records the code', () => {
    const t = exitFallbackTransition(127);
    expect(t.status).toBe('failed');
    expect(t.statusReason).toContain('127');
  });

  it('treats an unknown exit code as review, not failure', () => {
    expect(exitFallbackTransition(null).status).toBe('review');
    expect(exitFallbackTransition(undefined).status).toBe('review');
  });
});
