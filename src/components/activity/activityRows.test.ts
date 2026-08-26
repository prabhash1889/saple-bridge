import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../../types/agent';
import { deriveOutcome, formatDuration, sessionToRow } from './activityRows';

const BASE_SESSION: AgentSession = {
  id: 'agent-1',
  provider: 'claude',
  model: 'sonnet',
  role: 'builder',
  name: 'Builder One',
  cwd: 'C:/proj',
  outputLogPath: '.saple/agents/logs/log-1.ansi',
  status: 'running',
  startedAt: '2026-08-26T10:00:00.000Z',
  updatedAt: '2026-08-26T10:00:00.000Z',
  artifacts: [],
};

describe('deriveOutcome', () => {
  it('maps done to completed', () => {
    expect(deriveOutcome('done')).toBe('completed');
  });

  it('maps failed to failed', () => {
    expect(deriveOutcome('failed')).toBe('failed');
  });

  it('maps stopped to cancelled', () => {
    expect(deriveOutcome('stopped')).toBe('cancelled');
  });

  it('treats every live status as running', () => {
    const liveStatuses = ['idle', 'queued', 'starting', 'running', 'waiting', 'review', 'blocked'] as const;
    for (const status of liveStatuses) {
      expect(deriveOutcome(status)).toBe('running');
    }
  });
});

describe('formatDuration', () => {
  it('formats completed duration from startedAt to completedAt', () => {
    const duration = formatDuration(
      '2026-08-26T10:00:00.000Z',
      '2026-08-26T10:03:04.000Z',
    );
    expect(duration).toBe('3m 04s');
  });

  it('uses the passed now for running sessions', () => {
    const duration = formatDuration(
      '2026-08-26T10:00:00.000Z',
      undefined,
      Date.parse('2026-08-26T10:01:05.000Z'),
    );
    expect(duration).toBe('1m 05s');
  });

  it('returns an empty string when startedAt is not a valid date', () => {
    expect(formatDuration('', undefined, 0)).toBe('');
  });

  it('clamps negative spans to zero', () => {
    const duration = formatDuration(
      '2026-08-26T10:00:00.000Z',
      '2026-08-26T09:59:00.000Z',
    );
    expect(duration).toBe('0s');
  });
});

describe('sessionToRow', () => {
  it('maps a running session to a row with a ticking duration', () => {
    const row = sessionToRow(
      { ...BASE_SESSION },
      Date.parse('2026-08-26T10:02:00.000Z'),
    );
    expect(row).toMatchObject({
      id: 'agent-1',
      name: 'Builder One',
      providerModel: 'claude / sonnet',
      role: 'builder',
      outcome: 'running',
      duration: '2m 00s',
      transcriptPath: '.saple/agents/logs/log-1.ansi',
    });
  });

  it('prefers the transcript path over the raw output log', () => {
    const row = sessionToRow(
      { ...BASE_SESSION, transcriptPath: '.saple/agents/transcripts/t-1.md' },
      0,
    );
    expect(row.transcriptPath).toBe('.saple/agents/transcripts/t-1.md');
  });

  it('derives a cancelled outcome from a stopped session', () => {
    const row = sessionToRow(
      { ...BASE_SESSION, status: 'stopped' },
      0,
    );
    expect(row.outcome).toBe('cancelled');
  });
});
