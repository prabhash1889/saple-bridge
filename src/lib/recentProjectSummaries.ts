// Cross-project task summaries (Improvement Plan Phase 8.7).
//
// One batched, read-only IPC call fetches task counts for the renderer's recent-project
// paths. Rust reads each `.saple/tasks.json` directly without registering roots, starting
// watchers, or writing anything; outcomes reuse the Phase 2 state-load vocabulary so
// unreadable or corrupt projects fail closed to "unknown" instead of fake zero counts.

import { invoke } from '@tauri-apps/api/core';

export const MAX_SUMMARY_PROJECTS = 10;

export interface TaskColumnCounts {
  backlog: number;
  progress: number;
  review: number;
  done: number;
}

export type ProjectSummaryOutcome =
  | { status: 'missing' }
  | { status: 'loaded'; counts: TaskColumnCounts }
  | { status: 'corrupt'; error: string }
  | { status: 'locked' }
  | { status: 'ioError'; error: string };

export type RecentProjectSummary = { path: string } & ProjectSummaryOutcome;

export const fetchRecentProjectSummaries = (
  paths: string[],
): Promise<RecentProjectSummary[]> =>
  invoke('get_recent_project_summaries', {
    paths: paths.slice(0, MAX_SUMMARY_PROJECTS),
  });

// Glance line for one project's tasks. `progress` is the on-disk "running" state;
// `.saple/tasks.json` has no failure marker, so failed work is not representable yet.
export const summarizeTaskCounts = (counts: TaskColumnCounts): string => {
  const parts: string[] = [];
  if (counts.progress > 0) parts.push(`${counts.progress} running`);
  if (counts.review > 0) parts.push(`${counts.review} review`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.backlog > 0) parts.push(`${counts.backlog} queued`);
  return parts.length > 0 ? parts.join(' · ') : 'no tasks';
};

export const summarizeRecentProject = (summary: ProjectSummaryOutcome): string => {
  switch (summary.status) {
    case 'loaded':
      return summarizeTaskCounts(summary.counts);
    case 'missing':
      return 'no tasks';
    default:
      return 'unknown';
  }
};
