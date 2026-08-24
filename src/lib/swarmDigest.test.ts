import { describe, it, expect } from 'vitest';
import {
  buildResultsDigest,
  buildAcceptanceDigest,
  hashAcceptanceOutput,
  type DigestEntry,
} from './swarmDigest';

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

describe('buildAcceptanceDigest (Phase 5)', () => {
  const base = { command: 'npm test', wave: 2, maxWaves: 3, output: 'all 42 tests passed' };

  it('a pass asks for the final report with the done marker and the outcome path', () => {
    const digest = buildAcceptanceDigest([entry({ taskId: 't1' })], {
      ...base,
      passed: true,
      marker: 'tok12345',
      outcomePath: '.saple/swarm/outcomes/coordinator.json',
    });

    expect(digest).toContain('acceptance command passed');
    expect(digest).toContain('`npm test` exited 0');
    expect(digest).toContain('- t1 (Builder: fe) [builder]: done');
    expect(digest).toContain('.saple/swarm/outcomes/coordinator.json');
    expect(digest).toContain('[AGENT_DONE:tok12345]');
    expect(digest).not.toContain('[PLAN_UPDATED');
  });

  it('a failure embeds the output tail and asks for repair tasks via PLAN_UPDATED', () => {
    const digest = buildAcceptanceDigest([entry({ taskId: 't1' })], {
      ...base,
      passed: false,
      output: 'FAIL src/x.test.ts\nexpected 2 got 3',
      marker: 'tok12345',
    });

    expect(digest).toContain('Wave 2 of 3');
    expect(digest).toContain('FAILED');
    expect(digest).toContain('expected 2 got 3');
    expect(digest).toContain('[PLAN_UPDATED:tok12345]');
    expect(digest).not.toContain('[AGENT_DONE');
  });

  it('only the tail of a huge failure output rides along', () => {
    const digest = buildAcceptanceDigest([], {
      ...base,
      passed: false,
      output: `${'x'.repeat(5000)}THE-ACTUAL-ERROR`,
    });

    expect(digest).toContain('THE-ACTUAL-ERROR');
    expect(digest.length).toBeLessThan(3000);
  });
});

describe('hashAcceptanceOutput (Phase 5)', () => {
  it('is stable for identical trimmed output and differs otherwise', () => {
    expect(hashAcceptanceOutput('boom\n')).toBe(hashAcceptanceOutput('  boom  '));
    expect(hashAcceptanceOutput('boom')).not.toBe(hashAcceptanceOutput('other boom'));
  });
});
