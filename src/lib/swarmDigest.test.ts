import { describe, it, expect } from 'vitest';
import { buildResultsDigest, type DigestEntry } from './swarmDigest';

const entry = (extra: Partial<DigestEntry> = {}): DigestEntry => ({
  name: 'Builder: fe',
  role: 'builder',
  status: 'done',
  ...extra,
});

describe('buildResultsDigest', () => {
  it('formats a wave digest with scoped markers and per-task lines', () => {
    const digest = buildResultsDigest(
      [
        entry({ taskId: 'fe_auth', summary: 'login form shipped' }),
        entry({ taskId: 'be_api', status: 'failed', statusReason: 'exit code 1' }),
      ],
      { kind: 'wave', wave: 2, marker: 'tok12345' },
    );

    expect(digest).toContain('[Bridge digest] Wave 2: all worker tasks have finished.');
    expect(digest).toContain('- fe_auth (Builder: fe) [builder]: done - login form shipped');
    expect(digest).toContain('- be_api (Builder: fe) [builder]: failed - exit code 1');
    expect(digest).toContain('[AGENT_DONE:tok12345]');
    expect(digest).toContain('[PLAN_UPDATED:tok12345]');
  });

  it('prefers the outcome summary over the status reason', () => {
    const digest = buildResultsDigest(
      [entry({ taskId: 't', summary: 'what I did', statusReason: 'how it ended' })],
      { kind: 'wave', wave: 1, marker: 'm1' },
    );
    expect(digest).toContain('what I did');
    expect(digest).not.toContain('how it ended');
  });

  it('falls back to bare markers when no marker token exists', () => {
    const digest = buildResultsDigest([entry()], { kind: 'task_failed', wave: 1 });
    expect(digest).toContain('a task failed terminally');
    expect(digest).toContain('[AGENT_DONE]');
    expect(digest).toContain('[PLAN_UPDATED]');
  });

  it('labels an agent without a taskId by name and survives an empty roster', () => {
    const named = buildResultsDigest([entry()], { kind: 'crash_recovery', wave: 1, marker: 'm' });
    expect(named).toContain('- Builder: fe [builder]: done');
    expect(named).toContain('ended unexpectedly');

    const empty = buildResultsDigest([], { kind: 'crash_recovery', wave: 1, marker: 'm' });
    expect(empty).toContain('(no worker tasks yet)');
  });
});
