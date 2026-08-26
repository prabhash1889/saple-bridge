import { describe, expect, it, vi, beforeEach } from 'vitest';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  fetchRecentProjectSummaries,
  summarizeRecentProject,
  summarizeTaskCounts,
  MAX_SUMMARY_PROJECTS,
} from './recentProjectSummaries';

describe('summarizeTaskCounts', () => {
  it('joins non-zero column counts in running/review/done/queued order', () => {
    expect(
      summarizeTaskCounts({ backlog: 2, progress: 3, review: 1, done: 5 }),
    ).toBe('3 running · 1 review · 5 done · 2 queued');
  });

  it('omits zero groups', () => {
    expect(summarizeTaskCounts({ backlog: 0, progress: 0, review: 0, done: 4 })).toBe('4 done');
    expect(summarizeTaskCounts({ backlog: 1, progress: 0, review: 0, done: 0 })).toBe('1 queued');
  });

  it('renders an empty board as no tasks', () => {
    expect(summarizeTaskCounts({ backlog: 0, progress: 0, review: 0, done: 0 })).toBe('no tasks');
  });
});

describe('summarizeRecentProject', () => {
  it('formats loaded counts', () => {
    expect(
      summarizeRecentProject({
        status: 'loaded',
        counts: { backlog: 0, progress: 2, review: 0, done: 1 },
      }),
    ).toBe('2 running · 1 done');
  });

  it('treats a missing tasks file as an empty board', () => {
    expect(summarizeRecentProject({ status: 'missing' })).toBe('no tasks');
  });

  it.each(['corrupt', 'locked', 'ioError'] as const)('fails %s closed to unknown', (status) => {
    const summary =
      status === 'corrupt'
        ? { status, error: 'bad json' }
        : status === 'ioError'
          ? { status, error: 'locked by another process' }
          : { status };
    expect(summarizeRecentProject(summary)).toBe('unknown');
  });
});

describe('fetchRecentProjectSummaries', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue([]);
  });

  it('invokes the batched read-only command with the given paths', async () => {
    await fetchRecentProjectSummaries(['C:/a', 'C:/b']);
    expect(invokeMock).toHaveBeenCalledWith('get_recent_project_summaries', {
      paths: ['C:/a', 'C:/b'],
    });
  });

  it('caps the request at the most recent projects', async () => {
    const paths = Array.from({ length: MAX_SUMMARY_PROJECTS + 5 }, (_, i) => `C:/p${i}`);
    await fetchRecentProjectSummaries(paths);
    const sent = invokeMock.mock.calls[0][1] as { paths: string[] };
    expect(sent.paths).toHaveLength(MAX_SUMMARY_PROJECTS);
    expect(sent.paths[0]).toBe('C:/p0');
  });
});
