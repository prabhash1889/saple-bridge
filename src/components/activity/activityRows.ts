import type { AgentSession, AgentStatus } from '../../types/agent';
import { formatElapsed } from '../../lib/swarmStatus';

export type ActivityOutcome = 'running' | 'completed' | 'failed' | 'cancelled';

export function deriveOutcome(status: AgentStatus): ActivityOutcome {
  switch (status) {
    case 'done':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
      return 'cancelled';
    default:
      return 'running';
  }
}

export function formatDuration(startedAt: string, completedAt?: string, now = Date.now()): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return '';
  const end = completedAt !== undefined ? Date.parse(completedAt) : now;
  if (!Number.isFinite(end)) return '';
  return formatElapsed(Math.max(0, end - start));
}

export interface ActivityRow {
  id: string;
  name: string;
  providerModel: string;
  role: string;
  outcome: ActivityOutcome;
  duration: string;
  transcriptPath?: string;
}

export function sessionToRow(session: AgentSession, now = Date.now()): ActivityRow {
  const transcriptPath = session.transcriptPath ?? session.outputLogPath;
  return {
    id: session.id,
    name: session.name,
    providerModel: `${session.provider} / ${session.model}`,
    role: session.role,
    outcome: deriveOutcome(session.status),
    duration: formatDuration(session.startedAt, session.completedAt, now),
    transcriptPath,
  };
}
