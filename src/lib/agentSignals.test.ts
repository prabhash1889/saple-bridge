import { describe, it, expect } from 'vitest';
import {
  hasReviewSignal,
  mightContainSignal,
  getSwarmStatusFromOutput,
  exitFallbackTransition,
} from './agentSignals';

// Convenience: run the same pipeline the pty-output listener runs.
const detect = (tail: string) => getSwarmStatusFromOutput(tail, hasReviewSignal(tail));

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
