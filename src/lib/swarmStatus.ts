import type { AgentStatus } from '../types/agent';

// Single source of truth for status -> color, shared by the graph nodes and the grid cards so both
// views read status by color identically. Mirrors the mapping the graph shipped with.
export function swarmStatusColor(status: AgentStatus): string {
  switch (status) {
    case 'running':
    case 'starting':
      return 'var(--accent)';
    case 'done':
      return 'var(--color-success)';
    case 'failed':
      return 'var(--color-danger)';
    case 'review':
      return 'var(--color-warning)';
    case 'waiting':
    case 'queued':
      return 'var(--color-info)';
    case 'blocked':
      return 'var(--text-muted)';
    default:
      return 'var(--border)';
  }
}

// Compact legend shown above both views. running+starting collapse into one "Running" swatch —
// they share the accent color and the pulse as the single "active" state — so every swatch stays a
// distinct color.
export const SWARM_STATUS_LEGEND: { status: AgentStatus; label: string }[] = [
  { status: 'running', label: 'Running' },
  { status: 'waiting', label: 'Waiting' },
  { status: 'review', label: 'Review' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
  { status: 'blocked', label: 'Blocked' },
];

// Human-readable running duration. Compact: "45s", "3m 04s", "1h 05m".
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m ${String(total % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
